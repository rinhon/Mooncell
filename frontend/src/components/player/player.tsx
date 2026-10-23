import { useCallback, useEffect, useRef, useState, type RefObject } from "react"
import { Link } from "react-router-dom"
import { ArrowLeft, LoaderCircle, Play, TriangleAlert } from "lucide-react"
import type { ShowLibrary } from "@/lib/api"
import { usePlaybackSession } from "@/hooks/use-playback-session"
import type { PlaybackInfo, SeekPath } from "@/lib/player/types"
import { clampTime } from "@/lib/player/types"
import { HlsEngine } from "@/lib/player/hls-engine"
import { NativeEngine } from "@/lib/player/native-engine"
import type { PlaybackEngine } from "@/lib/player/engine"
import {
  beginSeekMetric,
  bindPlaybackMetrics,
  cancelSeekMetric,
  finishSeekMetric,
  recordSeekResponse,
  recordSeekSegment,
  setSeekPath,
} from "@/lib/player/playback-metrics"
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
  onStartupStepChange: (step: number | null) => void
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
  onStartupStepChange,
}: PlayerProps) {
  const root = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const engine = useRef<PlaybackEngine | null>(null)
  const renderer = useRef<Anime4kRenderer | null>(null)
  useEffect(() => {
    if (root.current) return bindPlaybackMetrics(root.current, mediaId)
  }, [mediaId])
  const playback = usePlaybackSession(mediaId, info)
  const [position, setPosition] = useState(info.progress?.completed ? 0 : (info.progress?.position ?? 0))
  const [paused, setPaused] = useState(true)
  const [buffering, setBuffering] = useState(true)
  const [startupComplete, setStartupComplete] = useState(false)
  const streamReady = useRef(false)
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
  const activeSeek = useRef<{
    seekId: number
    target: number
    path: SeekPath
    sessionId: string | null
    generation: number | null
    awaitingRestart: boolean
    appliedAt: number | null
  } | null>(null)
  const frameCallback = useRef<number | null>(null)
  const targetFrameEvidence = useRef<{
    seekId: number
    sessionId: string
    generation: number
    instance: PlaybackEngine
    source: number
    observedAt: number
  } | null>(null)
  const recoveryInFlight = useRef<number | null>(null)
  const recoverSeek = useRef<((target: number) => void) | null>(null)
  const fallbackUsed = useRef(false)
  const fallbackInFlight = useRef(false)
  const [panel, setPanel] = useState<"episodes" | "settings" | null>(null)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [isFullscreen, setIsFullscreen] = useState(Boolean(document.fullscreenElement))
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pointerHeld = useRef(false)
  const panelTrigger = useRef<HTMLElement | null>(null)
  const problem =
    playback.error ??
    (session?.status === "failed"
      ? (session.error?.message ?? "视频准备失败，请重试。")
      : session?.status === "closed"
        ? "播放连接已关闭，请重试。"
        : null)
  const startupStep = problem || startupComplete ? null : !session ? 1 : session.status === "preparing" ? 2 : 3
  useEffect(() => {
    onStartupStepChange(startupStep)
  }, [startupStep, onStartupStepChange])
  const completeStartup = useCallback(() => {
    if (streamReady.current && (video.current?.readyState ?? 0) >= 2) setStartupComplete(true)
  }, [])
  const cancelTargetFrame = useCallback(() => {
    if (frameCallback.current !== null) video.current?.cancelVideoFrameCallback?.(frameCallback.current)
    frameCallback.current = null
  }, [])
  const targetSourceTime = useCallback(
    (mediaTime: number, observedAt: number) => {
      const pending = activeSeek.current
      const element = video.current
      if (!pending || !element || !engine.current) return null
      const source = engine.current.getSourceTime(mediaTime)
      const tolerance = Math.max(0.012, Math.min(0.1, 1.5 / (info.frame_rate || 24)))
      const elapsed =
        pending.appliedAt !== null && !element.paused
          ? (Math.max(0, observedAt - pending.appliedAt) / 1000) * element.playbackRate
          : 0
      return Number.isFinite(source) &&
        source >= pending.target - tolerance &&
        source <= pending.target + tolerance + elapsed &&
        Math.abs(source - engine.current.getSourceTime()) <= Math.max(0.1, tolerance * 2)
        ? source
        : null
    },
    [info.frame_rate],
  )
  const confirmTargetFrame = useCallback(
    (source: number, evidence: "video-frame" | "seeked-fallback", observedAt = performance.now()) => {
      const pending = activeSeek.current
      const value = sessionRef.current
      const element = video.current
      if (
        !pending ||
        pending.awaitingRestart ||
        !streamReady.current ||
        !element ||
        element.seeking ||
        !engine.current ||
        value?.id !== pending.sessionId ||
        value.generation !== pending.generation
      )
        return false
      finishSeekMetric(pending.seekId, source, evidence, observedAt)
      cancelTargetFrame()
      targetFrameEvidence.current = null
      activeSeek.current = null
      pendingLocalSeek.current = null
      setPosition(source)
      callbacks.current.clock.current = {
        position: source,
        paused: element.paused,
        playbackRate: element.playbackRate,
        completed: source >= info.duration - 2,
      }
      setBuffering(false)
      return true
    },
    [info.duration, cancelTargetFrame],
  )
  const confirmObservedFrame = useCallback(() => {
    const proof = targetFrameEvidence.current
    const pending = activeSeek.current
    const element = video.current
    if (
      !proof ||
      !pending ||
      !element ||
      proof.seekId !== pending.seekId ||
      proof.instance !== engine.current ||
      proof.sessionId !== pending.sessionId ||
      proof.generation !== pending.generation ||
      targetSourceTime(element.currentTime, performance.now()) === null
    )
      return false
    return confirmTargetFrame(proof.source, "video-frame", proof.observedAt)
  }, [confirmTargetFrame, targetSourceTime])
  const watchTargetFrame = useCallback(
    function watch() {
      const element = video.current
      const pending = activeSeek.current
      if (!pending || !streamReady.current || !element?.requestVideoFrameCallback || frameCallback.current !== null)
        return
      const seekId = pending.seekId
      const instance = engine.current
      if (!instance) return
      frameCallback.current = element.requestVideoFrameCallback((_now, metadata) => {
        frameCallback.current = null
        if (activeSeek.current?.seekId !== seekId) return
        if (instance === engine.current) {
          const observedAt = performance.now()
          const source = targetSourceTime(metadata.mediaTime, observedAt)
          const value = sessionRef.current
          if (source !== null && value)
            targetFrameEvidence.current = {
              seekId,
              sessionId: value.id,
              generation: value.generation,
              instance,
              source,
              observedAt,
            }
        }
        if (!confirmObservedFrame()) watch()
      })
    },
    [confirmObservedFrame, targetSourceTime],
  )
  useEffect(
    () => () => {
      cancelTargetFrame()
      if (activeSeek.current) cancelSeekMetric(activeSeek.current.seekId)
    },
    [cancelTargetFrame],
  )
  useEffect(() => {
    if (!problem) return
    cancelTargetFrame()
    targetFrameEvidence.current = null
    if (activeSeek.current) cancelSeekMetric(activeSeek.current.seekId, "failed")
    activeSeek.current = null
    pendingLocalSeek.current = null
    recoveryInFlight.current = null
  }, [problem, cancelTargetFrame])
  const tryTranscodeFallback = useCallback(
    (message: string) => {
      if (fallbackInFlight.current) return true
      const value = sessionRef.current
      if (fallbackUsed.current || (value?.playback_mode !== "direct" && value?.playback_mode !== "remux")) return false
      fallbackUsed.current = true
      fallbackInFlight.current = true
      suppressPause.current = true
      cancelTargetFrame()
      targetFrameEvidence.current = null
      if (activeSeek.current) activeSeek.current.awaitingRestart = true
      setBuffering(true)
      setNotice("正在切换为兼容播放…")
      void callbacks.current.fallback().then((next) => {
        if (!next) {
          fallbackInFlight.current = false
          callbacks.current.setError(message)
          return
        }
        const pending = activeSeek.current
        if (pending) {
          pending.sessionId = next.id
          pending.generation = next.generation
          pending.awaitingRestart = false
          recordSeekResponse(pending.seekId, next)
        }
      })
      return true
    },
    [cancelTargetFrame],
  )
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
    if (
      !element ||
      !(value?.stream_url ?? value?.playlist_url) ||
      (value.status !== "ready" && value.status !== "paused")
    )
      return
    const generation = value.generation
    const sessionId = value.id
    streamReady.current = false
    suppressPause.current = true
    setBuffering(true)
    fallbackInFlight.current = false
    let instance: PlaybackEngine | null = null
    try {
      const Engine = value.playback_mode === "direct" ? NativeEngine : HlsEngine
      instance = new Engine(
        element,
        value,
        (message) => {
          if (sessionRef.current?.id !== sessionId || sessionRef.current?.generation !== generation) return
          if (tryTranscodeFallback(message)) return
          callbacks.current.setError(message)
          setBuffering(false)
        },
        () => {
          if (sessionRef.current?.id !== sessionId || sessionRef.current?.generation !== generation) return
          streamReady.current = true
          if (value.playback_mode !== "direct")
            instance?.alignToSource(activeSeek.current?.target ?? value.position ?? value.source_anchor)
          if (activeSeek.current) activeSeek.current.appliedAt = performance.now()
          completeStartup()
          element.volume = preferences.current.volume
          element.playbackRate = preferences.current.rate
          suppressPause.current = false
          renderer.current?.renderCurrentFrame()
          if (!activeSeek.current) setBuffering(false)
          watchTargetFrame()
          const seekId = activeSeek.current?.seekId
          if (desiredPlaying.current)
            void element.play().catch(() => {
              if (
                sessionRef.current?.id !== sessionId ||
                sessionRef.current?.generation !== generation ||
                activeSeek.current?.seekId !== seekId
              )
                return
              desiredPlaying.current = false
              setPaused(true)
              setNotice("视频已就绪，点击播放开始。")
            })
        },
        (start, end) => {
          const pending = activeSeek.current
          if (
            pending &&
            pending.sessionId === sessionId &&
            pending.generation === generation &&
            pending.target >= start - 0.1 &&
            pending.target < end
          )
            recordSeekSegment(pending.seekId, sessionRef.current ?? undefined)
        },
      )
      engine.current = instance
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "无法初始化播放器"
      if (!tryTranscodeFallback(message)) callbacks.current.setError(message)
    }
    return () => {
      streamReady.current = false
      cancelTargetFrame()
      targetFrameEvidence.current = null
      suppressPause.current = true
      if (engine.current === instance) engine.current = null
      instance?.destroy()
    }
  }, [
    session?.id,
    session?.generation,
    Boolean(
      (session?.stream_url ?? session?.playlist_url) && (session?.status === "ready" || session?.status === "paused"),
    ),
    completeStartup,
    watchTargetFrame,
    cancelTargetFrame,
    tryTranscodeFallback,
  ])
  useEffect(() => {
    if (!session) return
    engine.current?.update(session)
    const pending = pendingLocalSeek.current
    if (!pending) return
    if (pending.id !== session.id || pending.generation !== session.generation) {
      pendingLocalSeek.current = null
    } else if (engine.current && engine.current.seek(pending.position) !== "miss") {
      pendingLocalSeek.current = null
      renderer.current?.renderCurrentFrame()
      watchTargetFrame()
    }
  }, [session, watchTargetFrame])

  const sync = useCallback(() => {
    const element = video.current
    if (!element || !engine.current) return
    // Keep the requested source time stable until its own frame is presented.
    if (activeSeek.current) return
    const value = engine.current?.getSourceTime() ?? callbacks.current.clock.current.position
    setPosition(value)
    callbacks.current.clock.current = {
      position: value,
      paused: element.paused,
      playbackRate: element.playbackRate,
      completed: element.ended || value >= info.duration - 2,
    }
    if (
      sessionRef.current?.needs_recovery &&
      !element.paused &&
      recoveryInFlight.current === null &&
      engine.current.getBufferedAhead() <= 6
    ) {
      recoverSeek.current?.(value)
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
    (target: number, forceRemote = false) => {
      const next = clampTime(target, info.duration - 0.05)
      cancelTargetFrame()
      targetFrameEvidence.current = null
      if (activeSeek.current) cancelSeekMetric(activeSeek.current.seekId)
      const current = sessionRef.current
      const seekId = beginSeekMetric(mediaId, current, next)
      if (forceRemote) recoveryInFlight.current = seekId
      const pending = {
        seekId,
        target: next,
        path: "miss" as SeekPath,
        sessionId: current?.id ?? null,
        generation: current?.generation ?? null,
        awaitingRestart: forceRemote,
        appliedAt: null as number | null,
      }
      activeSeek.current = pending
      setPosition(next)
      playback.clock.current.position = next
      playback.clock.current.completed = next >= info.duration - 2
      pendingLocalSeek.current = null
      desiredPlaying.current = !video.current?.paused || desiredPlaying.current
      const path = forceRemote ? "miss" : (engine.current?.seek(next) ?? "miss")
      pending.path = path
      pending.awaitingRestart = path === "miss"
      if (engine.current && Math.abs(engine.current.getSourceTime() - next) <= 0.1)
        pending.appliedAt = performance.now()
      setSeekPath(seekId, path)
      setBuffering(path !== "buffered")
      if (path !== "miss") {
        renderer.current?.renderCurrentFrame()
        if (path === "buffered") recordSeekSegment(seekId)
      } else {
        if (current) pendingLocalSeek.current = { id: current.id, generation: current.generation, position: next }
      }
      // A paused native Range seek may present its only frame before the API acknowledgement.
      watchTargetFrame()
      void playback.seek(next, { clientBuffered: path === "buffered" }).then((value) => {
        if (value) recordSeekResponse(seekId, value)
        if (recoveryInFlight.current === seekId) recoveryInFlight.current = null
        if (activeSeek.current?.seekId !== seekId) return
        if (!value) {
          if (fallbackInFlight.current) return
          cancelSeekMetric(seekId, "failed")
          activeSeek.current = null
          return
        }
        pending.sessionId = value.id
        pending.generation = value.generation
        pending.awaitingRestart = false
        if (value.status === "ready" || value.status === "paused") {
          if (path === "miss" && value.requires_reload === false && value.playback_mode !== "direct")
            engine.current?.seek(next)
          if (!confirmObservedFrame()) watchTargetFrame()
        }
      })
    },
    [info.duration, mediaId, playback.seek, cancelTargetFrame, watchTargetFrame, confirmObservedFrame],
  )
  recoverSeek.current = (target) => seek(target, true)
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
      data-playback-mode={session?.playback_mode ?? "transcode"}
      data-session-id={session?.id}
      data-generation={session?.generation}
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
            if (!video.current?.requestVideoFrameCallback && (video.current?.readyState ?? 0) >= 2) {
              const source = targetSourceTime(video.current!.currentTime, performance.now())
              if (source !== null) confirmTargetFrame(source, "seeked-fallback")
            } else if (!confirmObservedFrame()) watchTargetFrame()
            sync()
            renderer.current?.renderCurrentFrame()
          }}
          onWaiting={() => setBuffering(true)}
          onLoadedData={completeStartup}
          onCanPlay={completeStartup}
          onPlaying={() => {
            if (!streamReady.current || suppressPause.current) return
            completeStartup()
            if (!activeSeek.current) setBuffering(false)
            setPaused(false)
            desiredPlaying.current = true
            sync()
            playback.heartbeat()
          }}
          onPause={() => {
            if (suppressPause.current || video.current?.error) return
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
        {!problem && startupComplete && (playback.locating || session?.status === "preparing" || buffering) && (
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
                setStartupComplete(false)
                streamReady.current = false
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
          {(session?.quality ?? 0) === 0
            ? session?.playback_mode === "transcode"
              ? "自动"
              : "原画"
            : `${session?.quality}P`}
          {enhanced && <span>Anime4K</span>}
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
          quality={session?.quality ?? 0}
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
          onAudioTrack={(track) => playback.options(session?.quality ?? 0, track)}
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
