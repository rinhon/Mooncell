import Hls, { Events, ErrorTypes } from "hls.js"
import type { PlaybackSession, SeekPath } from "./types"
import { sourceTime } from "./types"
import type { PlaybackEngine } from "./engine"
import { bufferedAhead } from "./engine"

/** 以解复用后的实际视频 PTS 建立时钟锚点，禁止直播追赶。 */
export class HlsEngine implements PlaybackEngine {
  private hls: Hls
  private destroyed = false
  private anchor: { source: number; media: number } | null = null
  private retries = 0
  private expired = false
  private bufferedPts = new Map<number, number>()
  private session: PlaybackSession

  constructor(
    private video: HTMLVideoElement,
    session: PlaybackSession,
    private onError: (message: string, expired?: boolean) => void,
    private onReady: () => void,
    private onBuffered?: (sourceStart: number, sourceEnd: number) => void,
  ) {
    this.session = session
    if (!Hls.isSupported()) throw new Error("此浏览器暂不支持本站 HLS 播放，请使用 Chrome、Edge 或 Firefox。")
    this.hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      startPosition: 0,
      maxBufferLength: 30,
      maxMaxBufferLength: 45,
      maxBufferSize: 40 * 1024 * 1024,
      backBufferLength: 30,
      liveBackBufferLength: 30,
      liveSyncDuration: Number.MAX_SAFE_INTEGER,
      liveMaxLatencyDuration: Infinity,
      maxLiveSyncPlaybackRate: 1,
      // The default controller clamps the enormous latency to the window start,
      // and can still seek there when stalled outside the sliding window.
      // With no controller the public liveSyncPosition is null, disabling that seek.
      latencyController: undefined,
      liveDurationInfinity: true,
      capLevelToPlayerSize: true,
      manifestLoadPolicy: {
        default: {
          maxTimeToFirstByteMs: 10000,
          maxLoadTimeMs: 15000,
          timeoutRetry: { maxNumRetry: 2, retryDelayMs: 1000, maxRetryDelayMs: 3000 },
          errorRetry: { maxNumRetry: 2, retryDelayMs: 1000, maxRetryDelayMs: 3000 },
        },
      },
      xhrSetup(xhr) {
        xhr.withCredentials = true
      },
    })
    this.hls.on(Events.FRAG_BUFFERED, (_event, { frag }) => {
      if (this.destroyed || this.expired || typeof frag.sn !== "number") return
      // FRAG_BUFFERED carries the Fragment; the actual demuxed PTS belongs to
      // elementaryStreams.video (or a combined audiovideo stream), not frag.start.
      const pts = frag.elementaryStreams.video?.startPTS ?? frag.elementaryStreams.audiovideo?.startPTS
      if (pts == null || !Number.isFinite(pts)) return
      if (!this.anchor) {
        this.bufferedPts.set(frag.sn, pts)
        if (this.bufferedPts.size > 64) this.bufferedPts.delete(this.bufferedPts.keys().next().value!)
        this.establishAnchor()
      }
      if (this.anchor) this.onBuffered?.(this.getSourceTime(pts), this.getSourceTime(pts + frag.duration))
    })
    this.hls.on(Events.ERROR, (_event, data) => {
      if (this.destroyed || this.expired) return
      const status = data.response?.code
      if (status === 401 || status === 403) {
        this.expired = true
        data.fatal = true
        this.hls.stopLoad()
        this.video.pause()
        this.onError("登录已过期，请刷新页面重新登录。", true)
        return
      }
      if (!data.fatal) return
      if (data.type === ErrorTypes.MEDIA_ERROR && this.retries++ < 2) this.hls.recoverMediaError()
      else {
        this.hls.stopLoad()
        this.onError("视频加载失败，请重试播放。")
      }
    })
    this.hls.attachMedia(video)
    this.hls.loadSource(session.playlist_url!)
  }

  private establishAnchor() {
    if (this.anchor || this.destroyed || this.expired) return
    for (const segment of this.session.segments ?? []) {
      const pts = this.bufferedPts.get(segment.sequence)
      if (pts === undefined || !Number.isFinite(segment.source_start)) continue
      this.anchor = { source: segment.source_start, media: pts }
      this.bufferedPts.clear()
      this.onReady()
      return
    }
  }
  update(session: PlaybackSession) {
    if (this.destroyed || session.id !== this.session.id || session.generation !== this.session.generation) return
    this.session = session
    // A fragment may arrive before a polling snapshot includes its registered
    // source time. Reconcile that event once metadata arrives, without resetting
    // an already established anchor when historical segments leave the window.
    this.establishAnchor()
  }
  getSourceTime(mediaTime = this.video.currentTime) {
    if (!this.anchor) return this.session.source_anchor
    return sourceTime(mediaTime, this.anchor.source, this.anchor.media, this.session.duration)
  }
  alignToSource(position: number) {
    if (this.destroyed || this.expired || !this.anchor || !Number.isFinite(position)) return false
    const target = position - this.anchor.source + this.anchor.media
    if (!Number.isFinite(target) || target < 0) return false
    this.video.currentTime = target
    return true
  }
  seek(position: number): SeekPath {
    if (this.destroyed || this.expired || !this.anchor || !Number.isFinite(position) || position < 0) return "miss"
    const target = position - this.anchor.source + this.anchor.media
    if (!Number.isFinite(target) || target < 0) return "miss"
    for (let index = 0; index < this.video.buffered.length; index++) {
      if (target >= this.video.buffered.start(index) && target < this.video.buffered.end(index) - 0.1) {
        this.video.currentTime = target
        return "buffered"
      }
    }
    if (this.session.cached_ranges?.some(([start, end]) => position >= start && position < end)) {
      // The backend can reuse this generation beyond the browser's 30s buffer.
      // Setting the mapped media time raises `seeking`; hls.js then adjusts its
      // nextLoadPosition and fetches the corresponding already published segment.
      this.video.currentTime = target
      return "server-cache"
    }
    return "miss"
  }
  getBufferedAhead() {
    return bufferedAhead(this.video)
  }
  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.bufferedPts.clear()
    this.hls.destroy()
    this.video.pause()
    this.video.removeAttribute("src")
    this.video.load()
  }
}
