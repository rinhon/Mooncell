import { useCallback, useEffect, useRef, useState, type RefObject } from "react"
import { Link } from "react-router-dom"
import { ArrowLeft, LoaderCircle, Play, TriangleAlert } from "lucide-react"
import type { ShowLibrary } from "@/lib/api"
import { usePlaybackSession } from "@/hooks/use-playback-session"
import type { PlaybackInfo } from "@/lib/player/types"
import { clampTime } from "@/lib/player/types"
import { HlsEngine } from "@/lib/player/hls-engine"
import { createAnime4kRenderer, type Anime4kMode, type Anime4kRenderer } from "@/lib/player/anime4k-renderer"
import { PlayerControls } from "./player-controls"
import { PlayerEpisodes } from "./player-episodes"
import { SubtitleOverlay } from "./subtitle-overlay"

const PREFERENCE_KEY = "mooncell.anime4k"
function preferredMode(): Anime4kMode {
  try {
    const value = localStorage.getItem(PREFERENCE_KEY)
    return value === "light" || value === "standard" ? value : "off"
  } catch {
    return "off"
  }
}

interface PlayerProps {
  mediaId: string
  info: PlaybackInfo
  showTitle: string
  episodeTitle: string
  backTo: string
  artwork?: string
  library?: ShowLibrary
  libraryLoading: boolean
  libraryError?: string
  onRetryLibrary: () => void
  onSelectEpisode: (mediaId: string) => void
  fullscreenTarget: RefObject<HTMLElement | null>
  autoPlay: boolean
  savedPreferences: { volume: number; rate: number }
  onPreferencesChange: (value: { volume: number; rate: number }) => void
}

export function Player({
  mediaId,
  info,
  showTitle,
  episodeTitle,
  backTo,
  artwork,
  library,
  libraryLoading,
  libraryError,
  onRetryLibrary,
  onSelectEpisode,
  fullscreenTarget,
  autoPlay,
  savedPreferences,
  onPreferencesChange,
}: PlayerProps) {
  const root = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const engine = useRef<HlsEngine | null>(null)
  const renderer = useRef<Anime4kRenderer | null>(null)
  const playback = usePlaybackSession(mediaId, info)
  const [position, setPosition] = useState(info.progress?.completed ? 0 : (info.progress?.position ?? 0))
  const [paused, setPaused] = useState(true)
  const [buffering, setBuffering] = useState(true)
  const [volume, setVolume] = useState(savedPreferences.volume)
  const [rate, setRate] = useState(savedPreferences.rate)
  const preferences = useRef({ volume, rate })
  preferences.current = { volume, rate }
  useEffect(() => {
    onPreferencesChange({ volume, rate })
  }, [volume, rate, onPreferencesChange])
  const [subtitleTrack, setSubtitleTrack] = useState("")
  const [mode, setMode] = useState<Anime4kMode>(preferredMode)
  const [enhanced, setEnhanced] = useState(false)
  const [reason, setReason] = useState<string>()
  const [notice, setNotice] = useState("")
  const desiredPlaying = useRef(autoPlay)
  const suppressPause = useRef(true)
  const session = playback.session
  const sessionRef = useRef(session)
  sessionRef.current = session
  const callbacks = useRef(playback)
  callbacks.current = playback
  const pendingLocalSeek = useRef<{ id: string; generation: number; position: number } | null>(null)
  const [panel, setPanel] = useState<"episodes" | "settings" | null>(null)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [isFullscreen, setIsFullscreen] = useState(Boolean(document.fullscreenElement))
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pointerHeld = useRef(false)
  const panelTrigger = useRef<HTMLElement | null>(null)
  const problem = playback.error ?? (session?.status === "failed" ? session.error?.message : null)
  const playableEpisodes =
    library?.seasons.flatMap((season) => season.items).filter((item) => item.media_id && !item.rename_pending) ?? []
  const currentIndex = playableEpisodes.findIndex((item) => item.media_id === mediaId)
  const nextEpisode = currentIndex >= 0 ? playableEpisodes[currentIndex + 1] : undefined
  const revealControls = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    setControlsVisible(true)
    if (paused || buffering || panel || problem) return
    hideTimer.current = setTimeout(() => {
      const element = root.current
      if (pointerHeld.current || element?.querySelector(".player-controls:hover, .player-header:hover, :focus-visible"))
        return
      setControlsVisible(false)
    }, 3200)
  }, [paused, buffering, panel, problem])

  useEffect(() => {
    revealControls()
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
  }, [revealControls])

  useEffect(() => {
    const changed = () => {
      setIsFullscreen(Boolean(document.fullscreenElement))
      revealControls()
    }
    document.addEventListener("fullscreenchange", changed)
    return () => document.removeEventListener("fullscreenchange", changed)
  }, [revealControls])

  const changePanel = useCallback(
    (next: "episodes" | "settings" | null) => {
      if (next && !panel)
        panelTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setPanel(next)
      setControlsVisible(true)
      if (!next) panelTrigger.current?.focus({ preventScroll: true })
    },
    [panel],
  )

  const selectEpisode = (id: string) => {
    changePanel(null)
    if (id !== mediaId) onSelectEpisode(id)
  }

  useEffect(() => {
    if (!video.current || !canvas.current || !root.current) return
    const instance = createAnime4kRenderer({
      video: video.current,
      canvas: canvas.current,
      container: root.current,
      onStateChange: (state) => {
        setEnhanced(state.effectiveMode !== "off" && state.status === "ready")
        setReason(state.reason ?? undefined)
        canvas.current?.setAttribute("data-enhancement-mode", state.effectiveMode)
      },
      onNotice: setNotice,
      onMetrics: (metrics) => {
        canvas.current?.setAttribute("data-frame-latency-ms", metrics.submissionLatencyMs.toFixed(2))
        canvas.current?.setAttribute("data-frame-budget-ms", metrics.frameBudgetMs.toFixed(2))
      },
    })
    renderer.current = instance
    void instance.setMode(mode)
    return () => {
      instance.destroy()
      renderer.current = null
    }
  }, [])

  useEffect(() => {
    void renderer.current?.setMode(mode)
  }, [mode])
  useEffect(() => {
    const element = video.current
    const value = sessionRef.current
    if (!element || !value?.playlist_url || (value.status !== "ready" && value.status !== "paused")) return
    const generation = value.generation
    suppressPause.current = true
    setBuffering(true)
    let instance: HlsEngine | null = null
    try {
      instance = new HlsEngine(
        element,
        value,
        (message) => {
          callbacks.current.setError(message)
          setBuffering(false)
        },
        () => {
          if (sessionRef.current?.generation !== generation) return
          element.volume = preferences.current.volume
          element.playbackRate = preferences.current.rate
          suppressPause.current = false
          renderer.current?.renderCurrentFrame()
          setBuffering(false)
          if (desiredPlaying.current)
            void element.play().catch(() => {
              desiredPlaying.current = false
              setPaused(true)
              setNotice("视频已就绪，点击播放开始。")
            })
        },
      )
      engine.current = instance
    } catch (cause) {
      callbacks.current.setError(cause instanceof Error ? cause.message : "无法初始化播放器")
    }
    return () => {
      suppressPause.current = true
      if (engine.current === instance) engine.current = null
      instance?.destroy()
    }
  }, [
    session?.id,
    session?.generation,
    Boolean(session?.playlist_url && (session.status === "ready" || session.status === "paused")),
  ])
  useEffect(() => {
    if (!session) return
    engine.current?.update(session)
    const pending = pendingLocalSeek.current
    if (!pending) return
    if (pending.id !== session.id || pending.generation !== session.generation) {
      pendingLocalSeek.current = null
    } else if (engine.current?.seek(pending.position)) {
      pendingLocalSeek.current = null
      renderer.current?.renderCurrentFrame()
    }
  }, [session])

  const sync = useCallback(() => {
    const element = video.current
    if (!element || !engine.current) return
    const value = engine.current?.getSourceTime() ?? callbacks.current.clock.current.position
    setPosition(value)
    callbacks.current.clock.current = {
      position: value,
      paused: element.paused,
      playbackRate: element.playbackRate,
      completed: element.ended || value >= info.duration - 2,
    }
  }, [info.duration])
  const toggle = useCallback(() => {
    const element = video.current
    if (!element) return
    if (element.ended) {
      desiredPlaying.current = true
      setPosition(0)
      callbacks.current.restart(0)
      return
    }
    desiredPlaying.current = element.paused
    if (element.paused) {
      callbacks.current.clock.current.paused = false
      callbacks.current.heartbeat()
      if (element.readyState >= 2) void element.play().catch(() => setNotice("请等待视频准备完成后再播放。"))
    } else element.pause()
  }, [])
  const seek = useCallback(
    (target: number) => {
      const next = clampTime(target, info.duration - 0.05)
      setPosition(next)
      playback.clock.current.position = next
      pendingLocalSeek.current = null
      if (engine.current?.seek(next)) renderer.current?.renderCurrentFrame()
      else {
        const current = sessionRef.current
        if (current) pendingLocalSeek.current = { id: current.id, generation: current.generation, position: next }
        desiredPlaying.current = !video.current?.paused || desiredPlaying.current
      }
      playback.seek(next)
    },
    [info.duration, playback.seek],
  )
  const fullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    else {
      const target = fullscreenTarget.current ?? root.current
      if (!target?.requestFullscreen) {
        setNotice("当前浏览器不支持全屏，已使用页面全屏播放。")
        return
      }
      void target.requestFullscreen().catch(() => setNotice("浏览器无法进入全屏。"))
    }
  }, [fullscreenTarget])

  if (!info.supported)
    return (
      <div role="alert" className="watch-error">
        {info.unsupported_reason ?? "此视频暂不支持在线播放"}
      </div>
    )
  const subtitle = info.subtitle_tracks.find((track) => track.id === subtitleTrack)
  return (
    <div
      ref={root}
      className="mooncell-player"
      data-controls-visible={controlsVisible || paused || Boolean(panel) || Boolean(problem)}
      tabIndex={0}
      aria-label={`${showTitle} · ${episodeTitle}`}
      onPointerMove={revealControls}
      onPointerLeave={() => {
        pointerHeld.current = false
        revealControls()
      }}
      onPointerDown={() => {
        pointerHeld.current = true
        revealControls()
      }}
      onPointerUp={() => {
        pointerHeld.current = false
        revealControls()
      }}
      onPointerCancel={() => {
        pointerHeld.current = false
        revealControls()
      }}
      onFocusCapture={revealControls}
      onBlurCapture={revealControls}
      onKeyDownCapture={(event) => {
        if (event.key === "Escape" && panel) {
          event.preventDefault()
          event.stopPropagation()
          changePanel(null)
        }
      }}
      onKeyDown={(event) => {
        revealControls()
        if (event.target !== event.currentTarget && (event.target as HTMLElement).tagName !== "VIDEO") return
        if (event.code === "Space" || event.key.toLowerCase() === "k") {
          event.preventDefault()
          toggle()
        }
        if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
          event.preventDefault()
          seek(position + (event.key === "ArrowRight" ? 10 : -10))
        }
        if (event.key.toLowerCase() === "f") fullscreen()
      }}
    >
      <div className="player-stage">
        <video
          ref={video}
          className="player-video"
          style={{ opacity: enhanced ? 0 : 1 }}
          playsInline
          preload="auto"
          onClick={() => {
            root.current?.focus({ preventScroll: true })
            toggle()
          }}
          onTimeUpdate={sync}
          onSeeked={() => {
            sync()
            renderer.current?.renderCurrentFrame()
          }}
          onWaiting={() => setBuffering(true)}
          onPlaying={() => {
            setBuffering(false)
            setPaused(false)
            desiredPlaying.current = true
            sync()
            playback.heartbeat()
          }}
          onPause={() => {
            if (suppressPause.current) return
            desiredPlaying.current = false
            setPaused(true)
            sync()
            playback.save()
            playback.heartbeat()
          }}
          onEnded={() => {
            desiredPlaying.current = false
            sync()
            playback.save()
            setPaused(true)
          }}
        />
        <canvas
          ref={canvas}
          className="player-canvas"
          style={{ visibility: enhanced ? "visible" : "hidden" }}
          onClick={toggle}
        />
        <SubtitleOverlay url={subtitle?.url ?? null} position={position} generation={session?.generation ?? 0} />
        {!problem && (playback.locating || session?.status === "preparing" || buffering) && (
          <div className="player-status" role="status">
            <LoaderCircle className="player-spinner" size={34} />
            <span>{playback.locating ? "正在定位…" : "正在缓冲…"}</span>
          </div>
        )}
        {!problem && !buffering && !playback.locating && paused && !panel && (
          <button className="player-center-play" type="button" onClick={toggle} aria-label="开始播放">
            <Play size={33} fill="currentColor" aria-hidden="true" />
          </button>
        )}
        {problem && (
          <div className="player-message" role="alert">
            <TriangleAlert size={28} />
            <p>{problem}</p>
            <button
              className="player-action-button"
              onClick={() => {
                playback.setError(null)
                desiredPlaying.current = true
                playback.restart(position)
              }}
            >
              重试播放
            </button>
          </div>
        )}
        {notice && (
          <button className="player-notice" onClick={() => setNotice("")} aria-label="关闭提示">
            {notice}
          </button>
        )}
        {!problem && session?.error && (
          <div className="player-notice" role="status">
            {session.error.message}
          </div>
        )}
      </div>
      <header className="player-header" inert={!controlsVisible && !paused && !panel && !problem}>
        <Link className="player-icon-button player-back" to={backTo} aria-label="返回番剧" title="返回番剧">
          <ArrowLeft size={23} />
        </Link>
        <div className="player-heading">
          <h1>{showTitle}</h1>
          <p title={info.filename}>{episodeTitle}</p>
        </div>
        <span className="player-quality-badge">
          {session?.quality ?? info.qualities.at(-1) ?? 720}P{enhanced && <span>Anime4K</span>}
        </span>
      </header>
      {panel && <div className="player-panel-scrim" aria-hidden="true" onClick={() => changePanel(null)} />}
      <div className="player-controls-layer" inert={!controlsVisible && !paused && !panel && !problem}>
        <PlayerControls
          position={position}
          duration={info.duration}
          paused={paused}
          buffering={buffering}
          volume={volume}
          rate={rate}
          quality={session?.quality ?? info.qualities.at(-1) ?? 720}
          audioTrack={
            session?.audio_track ??
            info.audio_tracks.find((track) => track.default)?.id ??
            info.audio_tracks[0]?.id ??
            null
          }
          subtitleTrack={subtitleTrack}
          enhancement={mode}
          enhancementReason={reason}
          info={info}
          onTogglePlay={toggle}
          onSeek={seek}
          onVolume={(next) => {
            setVolume(next)
            if (video.current) video.current.volume = next
          }}
          onRate={(next) => {
            setRate(next)
            playback.clock.current.playbackRate = next
            if (video.current) video.current.playbackRate = next
          }}
          onQuality={(quality) => playback.options(quality, session?.audio_track ?? null)}
          onAudioTrack={(track) => playback.options(session?.quality ?? 720, track)}
          onSubtitleTrack={setSubtitleTrack}
          onEnhancement={(next) => {
            setMode(next)
            try {
              localStorage.setItem(PREFERENCE_KEY, next)
            } catch {
              /* 设备禁用存储时仅应用本次设置。 */
            }
          }}
          onFullscreen={fullscreen}
          fullscreen={isFullscreen}
          panel={panel}
          onPanelChange={changePanel}
          episodeCount={playableEpisodes.length}
          onInteraction={revealControls}
          onNextEpisode={nextEpisode?.media_id ? () => selectEpisode(nextEpisode.media_id!) : undefined}
        />
      </div>
      {panel === "episodes" && (
        <PlayerEpisodes
          library={library}
          mediaId={mediaId}
          showTitle={showTitle}
          artwork={artwork}
          loading={libraryLoading}
          error={libraryError}
          onRetry={onRetryLibrary}
          onClose={() => changePanel(null)}
          onSelect={selectEpisode}
        />
      )}
    </div>
  )
}
