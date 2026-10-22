import { useEffect, useId, useRef, useState, type CSSProperties } from "react"
import {
  ListVideo,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Settings2,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from "lucide-react"
import type { Anime4kMode } from "@/lib/player/anime4k-types"
import { clampTime, formatTime, type PlaybackInfo } from "@/lib/player/types"

export interface PlayerControlsProps {
  position: number
  duration: number
  paused: boolean
  buffering: boolean
  volume: number
  rate: number
  quality: number
  audioTrack: number | null
  subtitleTrack: string
  enhancement: Anime4kMode
  enhancementReason?: string
  info: PlaybackInfo
  fullscreen: boolean
  panel: "episodes" | "settings" | null
  episodeCount: number
  onPanelChange: (panel: "episodes" | "settings" | null) => void
  onNextEpisode?: () => void
  onInteraction: () => void
  onTogglePlay: () => void
  onSeek: (position: number) => void
  onVolume: (volume: number) => void
  onRate: (rate: number) => void
  onQuality: (quality: number) => void
  onAudioTrack: (track: number) => void
  onSubtitleTrack: (track: string) => void
  onEnhancement: (mode: Anime4kMode) => void
  onFullscreen: () => void
}

const SEEK_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"])

export function PlayerControls(props: PlayerControlsProps) {
  const [draftPosition, setDraftPosition] = useState<number | null>(null)
  const positionId = useId()
  const draftRef = useRef<number | null>(null)
  const settingsPanel = useRef<HTMLElement>(null)
  const closeSettingsButton = useRef<HTMLButtonElement>(null)
  const lastAudibleVolume = useRef(props.volume > 0 ? props.volume : 0.8)
  const maximum = Math.max(0, Number.isFinite(props.duration) ? props.duration : 0)
  const displayedPosition = clampTime(draftPosition ?? props.position, maximum)

  useEffect(() => {
    draftRef.current = null
    setDraftPosition(null)
  }, [props.info.media_id])

  useEffect(() => {
    if (props.volume > 0) lastAudibleVolume.current = props.volume
  }, [props.volume])

  useEffect(() => {
    if (props.panel === "settings") closeSettingsButton.current?.focus()
  }, [props.panel])

  function commitSeek() {
    const target = draftRef.current
    if (target === null) return
    draftRef.current = null
    setDraftPosition(null)
    props.onSeek(clampTime(target, maximum))
  }

  function cancelSeek() {
    draftRef.current = null
    setDraftPosition(null)
  }

  function toggleMute() {
    if (props.volume > 0) {
      lastAudibleVolume.current = props.volume
      props.onVolume(0)
    } else props.onVolume(lastAudibleVolume.current)
  }

  return (
    <div
      className="player-controls"
      onPointerDown={props.onInteraction}
      onPointerMove={props.onInteraction}
      onFocus={props.onInteraction}
      onKeyDown={(event) => {
        props.onInteraction()
        if (event.key !== "Escape") event.stopPropagation()
      }}
    >
      <div className="player-timeline">
        <label className="player-sr-only" htmlFor={positionId}>
          播放进度
        </label>
        <input
          id={positionId}
          className="player-range player-position"
          type="range"
          min={0}
          max={maximum || 1}
          step={0.1}
          value={displayedPosition}
          style={{ "--player-progress": `${maximum ? (displayedPosition / maximum) * 100 : 0}%` } as CSSProperties}
          disabled={maximum <= 0}
          aria-valuetext={`${formatTime(displayedPosition)}，共 ${formatTime(maximum)}`}
          onChange={(event) => {
            const next = Number(event.currentTarget.value)
            draftRef.current = next
            setDraftPosition(next)
          }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            props.onInteraction()
          }}
          onPointerUp={commitSeek}
          onPointerCancel={cancelSeek}
          onKeyUp={(event) => {
            if (SEEK_KEYS.has(event.key)) commitSeek()
          }}
          onBlur={commitSeek}
        />
      </div>
      <div className="player-toolbar">
        <div className="player-toolbar-left">
          <button
            className="player-icon-button player-play-button"
            type="button"
            onClick={props.onTogglePlay}
            aria-label={props.paused ? "播放" : "暂停"}
            title={props.paused ? "播放（空格）" : "暂停（空格）"}
          >
            {props.paused ? (
              <Play size={25} fill="currentColor" aria-hidden="true" />
            ) : (
              <Pause size={25} fill="currentColor" aria-hidden="true" />
            )}
          </button>
          <button
            className="player-icon-button player-seek-button"
            type="button"
            onClick={() => props.onSeek(clampTime(props.position - 10, maximum))}
            disabled={maximum <= 0}
            aria-label="后退 10 秒"
            title="后退 10 秒（←）"
          >
            <RotateCcw size={26} aria-hidden="true" />
            <span className="player-seek-seconds" aria-hidden="true">
              10
            </span>
          </button>
          <button
            className="player-icon-button player-seek-button"
            type="button"
            onClick={() => props.onSeek(clampTime(props.position + 10, maximum))}
            disabled={maximum <= 0}
            aria-label="前进 10 秒"
            title="前进 10 秒（→）"
          >
            <RotateCw size={26} aria-hidden="true" />
            <span className="player-seek-seconds" aria-hidden="true">
              10
            </span>
          </button>
          <button
            className="player-icon-button player-next-button"
            type="button"
            onClick={props.onNextEpisode}
            disabled={!props.onNextEpisode}
            aria-label="播放下一集"
            title={props.onNextEpisode ? "播放下一集" : "没有下一集"}
          >
            <SkipForward size={23} fill="currentColor" aria-hidden="true" />
          </button>
          <div className="player-volume-control">
            <button
              className="player-icon-button"
              type="button"
              onClick={toggleMute}
              aria-label={props.volume === 0 ? "取消静音" : "静音"}
              title={props.volume === 0 ? "取消静音" : "静音"}
            >
              {props.volume === 0 ? (
                <VolumeX size={22} aria-hidden="true" />
              ) : props.volume < 0.5 ? (
                <Volume1 size={22} aria-hidden="true" />
              ) : (
                <Volume2 size={22} aria-hidden="true" />
              )}
            </button>
            <label className="player-volume" title="音量">
              <span className="player-sr-only">音量</span>
              <input
                className="player-range"
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={props.volume}
                style={{ "--player-progress": `${props.volume * 100}%` } as CSSProperties}
                aria-valuetext={`${Math.round(props.volume * 100)}%`}
                onChange={(event) => props.onVolume(Number(event.currentTarget.value))}
              />
            </label>
          </div>
          <output className="player-time" aria-label="播放时间" aria-live="off">
            {formatTime(displayedPosition)} <span>/</span> {formatTime(maximum)}
          </output>
          <span className="player-sr-only" role="status">
            {props.buffering ? "正在缓冲…" : props.paused ? "已暂停" : "播放中"}
          </span>
        </div>
        <div className="player-toolbar-right">
          <button
            className="player-icon-button player-episodes-button"
            type="button"
            onClick={() => props.onPanelChange(props.panel === "episodes" ? null : "episodes")}
            aria-label={props.episodeCount ? `选集，共 ${props.episodeCount} 集` : "选集"}
            aria-expanded={props.panel === "episodes"}
            aria-controls="player-episodes-panel"
            title="选集"
          >
            <ListVideo size={23} aria-hidden="true" />
            <span className="player-button-label">选集</span>
          </button>
          <button
            className="player-icon-button player-settings-button"
            type="button"
            onClick={() => props.onPanelChange(props.panel === "settings" ? null : "settings")}
            aria-label="播放设置"
            aria-expanded={props.panel === "settings"}
            aria-controls="player-settings-panel"
            title="播放设置"
          >
            <Settings2 size={22} aria-hidden="true" />
          </button>
          <button
            className="player-icon-button player-fullscreen-button"
            type="button"
            onClick={props.onFullscreen}
            aria-label={props.fullscreen ? "退出全屏" : "进入全屏"}
            title={props.fullscreen ? "退出全屏（F）" : "进入全屏（F）"}
          >
            {props.fullscreen ? <Minimize size={22} aria-hidden="true" /> : <Maximize size={22} aria-hidden="true" />}
          </button>
        </div>
      </div>
      {props.panel === "settings" && (
        <section
          ref={settingsPanel}
          className="player-settings-panel"
          id="player-settings-panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="player-settings-title"
          onKeyDown={(event) => {
            if (event.key !== "Tab") return
            const focusable = settingsPanel.current?.querySelectorAll<HTMLElement>(
              'button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex="0"]',
            )
            if (!focusable?.length) return
            const first = focusable[0]
            const last = focusable[focusable.length - 1]
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault()
              last.focus()
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault()
              first.focus()
            }
          }}
        >
          <div className="player-panel-heading">
            <h2 className="player-panel-title" id="player-settings-title">
              播放设置
            </h2>
            <button
              ref={closeSettingsButton}
              className="player-icon-button"
              type="button"
              onClick={() => props.onPanelChange(null)}
              aria-label="关闭播放设置"
              title="关闭播放设置"
            >
              <X size={19} aria-hidden="true" />
            </button>
          </div>
          <div className="player-settings-fields">
            <label>
              倍速
              <select value={props.rate} onChange={(event) => props.onRate(Number(event.currentTarget.value))}>
                {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((rate) => (
                  <option key={rate} value={rate}>
                    {rate === 1 ? "正常速度" : `${rate} 倍`}
                  </option>
                ))}
              </select>
            </label>
            <label>
              清晰度
              <select
                value={props.quality}
                onChange={(event) => props.onQuality(Number(event.currentTarget.value))}
                disabled={!props.info.qualities.length}
              >
                {!props.info.qualities.length && <option value={props.quality}>暂不可用</option>}
                {props.info.qualities.map((quality) => (
                  <option key={quality} value={quality}>
                    {quality}p
                  </option>
                ))}
              </select>
            </label>
            <label>
              音轨
              <select
                value={props.audioTrack ?? ""}
                onChange={(event) => props.onAudioTrack(Number(event.currentTarget.value))}
                disabled={!props.info.audio_tracks.length}
              >
                {!props.info.audio_tracks.length && <option value="">无音轨</option>}
                {props.info.audio_tracks.map((track, index) => (
                  <option key={track.id} value={track.id}>
                    {[track.title || `音轨 ${index + 1}`, track.language, track.codec].filter(Boolean).join(" · ")}
                  </option>
                ))}
              </select>
            </label>
            <label>
              字幕
              <select
                value={props.subtitleTrack}
                onChange={(event) => props.onSubtitleTrack(event.currentTarget.value)}
              >
                <option value="">关闭字幕</option>
                {props.info.subtitle_tracks.map((track, index) => (
                  <option key={track.id} value={track.id} disabled={!track.supported} title={track.reason ?? undefined}>
                    {[
                      track.title || `字幕 ${index + 1}`,
                      track.language,
                      !track.supported ? `不支持：${track.reason || track.codec}` : track.codec,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </option>
                ))}
              </select>
            </label>
            <label className="player-enhancement-setting">
              Anime4K 画面增强
              <select
                value={props.enhancement}
                onChange={(event) => props.onEnhancement(event.currentTarget.value as Anime4kMode)}
              >
                <option value="off">关闭</option>
                <option value="light">轻量</option>
                <option value="standard">标准</option>
              </select>
            </label>
            {props.enhancementReason && (
              <p className="player-enhancement-reason" role="status">
                {props.enhancementReason}
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  )
}
