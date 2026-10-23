import type { PlaybackEngine } from "./engine"
import { bufferedAhead } from "./engine"
import type { PlaybackSession, SeekPath } from "./types"
import { clampTime } from "./types"

/** Same-origin file playback lets the browser resolve its own container index and Range requests. */
export class NativeEngine implements PlaybackEngine {
  private destroyed = false
  private ready = false
  private target: number
  private listeners: [string, EventListener][] = []

  constructor(
    private video: HTMLVideoElement,
    private session: PlaybackSession,
    onError: (message: string) => void,
    onReady: () => void,
    onBuffered?: (sourceStart: number, sourceEnd: number) => void,
  ) {
    if (!session.stream_url) throw new Error("视频流地址不可用。")
    const url = new URL(session.stream_url, window.location.href)
    if (url.origin !== window.location.origin) throw new Error("视频地址必须与当前页面同源。")
    this.target = clampTime(session.position ?? session.source_anchor, session.duration)
    this.listen("loadedmetadata", () => this.alignToSource(this.target))
    const usable = () => {
      if (
        this.destroyed ||
        this.ready ||
        video.readyState < 2 ||
        video.seeking ||
        Math.abs(video.currentTime - this.target) > 0.75
      )
        return
      this.ready = true
      onReady()
    }
    this.listen("loadeddata", usable)
    this.listen("canplay", usable)
    this.listen("seeked", usable)
    this.listen("progress", () => {
      for (let index = 0; index < video.buffered.length; index++)
        onBuffered?.(video.buffered.start(index), video.buffered.end(index))
    })
    this.listen("error", () => {
      if (!this.destroyed) onError("浏览器无法直接播放此视频。")
    })
    video.src = url.href
    video.load()
  }

  private listen(name: string, listener: EventListener) {
    this.listeners.push([name, listener])
    this.video.addEventListener(name, listener)
  }
  update(session: PlaybackSession) {
    if (!this.destroyed && session.id === this.session.id && session.generation === this.session.generation)
      this.session = session
  }
  getSourceTime(mediaTime = this.video.currentTime) {
    return clampTime(mediaTime, this.session.duration)
  }
  alignToSource(position: number) {
    if (this.destroyed || this.video.readyState < 1 || !Number.isFinite(position)) return false
    this.target = clampTime(position, this.session.duration)
    if (Math.abs(this.video.currentTime - this.target) > 0.01) this.video.currentTime = this.target
    return true
  }
  seek(position: number): SeekPath {
    if (!this.alignToSource(position)) return "miss"
    return bufferedAhead(this.video) > 0.1 ? "buffered" : "miss"
  }
  getBufferedAhead() {
    return bufferedAhead(this.video)
  }
  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    for (const [name, listener] of this.listeners) this.video.removeEventListener(name, listener)
    this.listeners.length = 0
    this.video.pause()
    this.video.removeAttribute("src")
    this.video.load()
  }
}
