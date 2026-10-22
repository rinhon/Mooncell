import { useCallback, useEffect, useRef, useState } from "react"
import { api, ApiError } from "@/lib/api"
import type { PlaybackInfo, PlaybackSession } from "@/lib/player/types"

type Clock = { position: number; paused: boolean; playbackRate: number; completed?: boolean }
let lifecycleQueue: Promise<unknown> = Promise.resolve()
const CLIENT_ID_KEY = "mooncell.playback.client-id"
let tabClientId: string | undefined

function playbackUuid(): string {
  const provider = globalThis.crypto
  if (typeof provider?.randomUUID === "function") return provider.randomUUID()
  // randomUUID is restricted to secure contexts; getRandomValues is available
  // on ordinary HTTP LAN pages too. These UUIDs identify requests, not credentials.
  if (typeof provider?.getRandomValues !== "function") {
    throw new Error("浏览器无法生成播放请求标识，请更换浏览器或使用 HTTPS。")
  }
  const bytes = provider.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

function playbackClientId(): string {
  if (tabClientId) return tabClientId
  try {
    const stored = window.sessionStorage.getItem(CLIENT_ID_KEY)
    if (stored && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(stored)) {
      tabClientId = stored
      return stored
    }
  } catch {
    /* Restricted storage still gets a stable ID for this loaded module. */
  }
  tabClientId = playbackUuid()
  try {
    window.sessionStorage.setItem(CLIENT_ID_KEY, tabClientId)
  } catch {
    /* Use the module fallback. */
  }
  return tabClientId
}

export function usePlaybackSession(mediaId: string, info: PlaybackInfo | undefined) {
  const [session, setSession] = useState<PlaybackSession | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [locating, setLocating] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const restartPosition = useRef<number | null>(null)
  const current = useRef<PlaybackSession | null>(null)
  const clock = useRef<Clock>({ position: 0, paused: true, playbackRate: 1 })
  const epoch = useRef(0)
  const sequence = useRef(0)
  const control = useRef(0)
  const pending = useRef<Promise<unknown>>(Promise.resolve())
  const alive = useRef(false)
  const unauthorized = useRef(false)
  const pageHidden = useRef(false)
  const closedOnHide = useRef<string | null>(null)
  const changing = useRef(false)
  const heartbeatInFlight = useRef(false)
  const heartbeatQueued = useRef(false)
  const snapshotSequence = useRef(0)
  const acceptedSnapshot = useRef(0)
  const fail = useCallback((cause: unknown, token: number) => {
    if (!alive.current || token !== epoch.current) return
    if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) unauthorized.current = true
    setError(cause instanceof Error ? cause.message : "播放请求失败")
  }, [])
  const accept = useCallback((value: PlaybackSession, token: number, snapshot = ++snapshotSequence.current) => {
    if (!alive.current || unauthorized.current || token !== epoch.current || snapshot < acceptedSnapshot.current) return
    if (current.current && (value.id !== current.current.id || value.generation < current.current.generation)) return
    acceptedSnapshot.current = snapshot
    current.current = value
    setSession(value)
    if (value.status === "failed") setError(value.error?.message ?? "转码失败")
    if (value.status === "ready" || value.status === "paused") setLocating(false)
  }, [])

  useEffect(() => {
    if (!info?.supported) return
    const token = ++epoch.current
    alive.current = true
    pageHidden.current = false
    closedOnHide.current = null
    unauthorized.current = false
    current.current = null
    setSession(null)
    setError(null)
    setLocating(false)
    sequence.current = 0
    changing.current = false
    heartbeatInFlight.current = false
    heartbeatQueued.current = false
    snapshotSequence.current = 0
    acceptedSnapshot.current = 0
    clock.current = {
      position: restartPosition.current ?? (info.progress?.completed ? 0 : (info.progress?.position ?? 0)),
      paused: true,
      playbackRate: 1,
    }
    restartPosition.current = null
    let ownedId: string | null = null
    let stopped = false
    // StrictMode 的首次 effect 在发请求前可取消；已发送的请求仍有独立回收责任。
    lifecycleQueue = lifecycleQueue
      .catch(() => {})
      .then(async () => {
        if (stopped) return
        try {
          const value = await api<PlaybackSession>("/playback/sessions", {
            method: "POST",
            body: JSON.stringify({
              media_id: mediaId,
              client_id: playbackClientId(),
              start_time: clock.current.position,
              quality: info.qualities.at(-1) ?? 720,
              audio_track: info.audio_tracks.find((track) => track.default)?.id ?? info.audio_tracks[0]?.id ?? null,
              request_id: playbackUuid(),
            }),
          })
          ownedId = value.id
          if (stopped || pageHidden.current || epoch.current !== token) {
            if (pageHidden.current && epoch.current === token) closedOnHide.current = value.id
            await api(`/playback/sessions/${value.id}`, { method: "DELETE", keepalive: true }).catch(() => {})
          } else accept(value, token)
        } catch (cause) {
          if (!stopped) fail(cause, token)
        }
      })
    let polling = false
    const poll = window.setInterval(() => {
      const value = current.current
      if (
        stopped ||
        pageHidden.current ||
        polling ||
        changing.current ||
        unauthorized.current ||
        !value ||
        value.status === "closed" ||
        value.status === "failed"
      )
        return
      const revision = control.current
      const snapshot = ++snapshotSequence.current
      polling = true
      void api<PlaybackSession>(`/playback/sessions/${value.id}`)
        .then((next) => {
          if (!stopped && !changing.current && revision === control.current) accept(next, token, snapshot)
        })
        .catch((cause) => {
          if (!stopped) fail(cause, token)
        })
        .finally(() => {
          polling = false
        })
    }, 1500)
    return () => {
      stopped = true
      alive.current = false
      ++epoch.current
      ++control.current
      window.clearInterval(poll)
      const value = current.current
      if (!pageHidden.current && !unauthorized.current && !changing.current && value && value.id === ownedId) {
        const update = {
          session_id: value.id,
          generation: value.generation,
          sequence: ++sequence.current,
          position: clock.current.position,
          completed: clock.current.completed ?? false,
        }
        void api(`/media/${mediaId}/progress`, { method: "PUT", body: JSON.stringify(update), keepalive: true }).catch(
          () => {},
        )
      }
      const controlFinished = pending.current
      if (ownedId && closedOnHide.current !== ownedId)
        lifecycleQueue = lifecycleQueue
          .catch(() => {})
          .then(async () => {
            await controlFinished.catch(() => {})
            await api(`/playback/sessions/${ownedId}`, { method: "DELETE", keepalive: true }).catch(() => {})
          })
      current.current = null
    }
  }, [mediaId, info?.version, accept, fail, attempt])

  const save = useCallback(
    (keepalive = false) => {
      const value = current.current
      if (
        !alive.current ||
        unauthorized.current ||
        changing.current ||
        !value ||
        value.status === "failed" ||
        value.status === "closed"
      )
        return
      const token = epoch.current
      void api(`/media/${mediaId}/progress`, {
        method: "PUT",
        body: JSON.stringify({
          session_id: value.id,
          generation: value.generation,
          sequence: ++sequence.current,
          position: clock.current.position,
          completed: clock.current.completed ?? false,
        }),
        keepalive,
      }).catch((cause) => {
        if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) fail(cause, token)
      })
    },
    [mediaId, fail],
  )

  const heartbeat = useCallback(
    function sendHeartbeat() {
      const value = current.current
      if (
        !alive.current ||
        changing.current ||
        unauthorized.current ||
        !value ||
        value.status === "failed" ||
        value.status === "closed"
      )
        return
      if (heartbeatInFlight.current) {
        heartbeatQueued.current = true
        return
      }
      const revision = control.current
      const token = epoch.current
      const snapshot = ++snapshotSequence.current
      heartbeatInFlight.current = true
      void api<PlaybackSession>(`/playback/sessions/${value.id}/heartbeat`, {
        method: "POST",
        body: JSON.stringify({
          generation: value.generation,
          position: clock.current.position,
          paused: clock.current.paused,
          playback_rate: clock.current.playbackRate,
        }),
      })
        .then((next) => {
          if (!changing.current && revision === control.current) accept(next, token, snapshot)
        })
        .catch((cause) => {
          if (cause instanceof ApiError && cause.status === 409) return
          fail(cause, token)
        })
        .finally(() => {
          if (token !== epoch.current) return
          heartbeatInFlight.current = false
          if (heartbeatQueued.current) {
            heartbeatQueued.current = false
            sendHeartbeat()
          }
        })
    },
    [accept, fail],
  )

  useEffect(() => {
    const timer = window.setInterval(() => {
      heartbeat()
      save()
    }, 15000)
    const leave = () => {
      if (pageHidden.current) return
      save(true)
      pageHidden.current = true
      alive.current = false
      ++control.current
      const value = current.current
      if (value && closedOnHide.current !== value.id) {
        closedOnHide.current = value.id
        // Start immediately: an unload cannot wait for the ordinary control queue.
        // The server accepts the final progress write after a recent close.
        const closing = api(`/playback/sessions/${value.id}`, { method: "DELETE", keepalive: true }).catch(() => {})
        lifecycleQueue = lifecycleQueue.catch(() => {}).then(() => closing)
      }
    }
    const restore = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      restartPosition.current = clock.current.position
      setAttempt((value) => value + 1)
    }
    window.addEventListener("pagehide", leave)
    window.addEventListener("pageshow", restore)
    return () => {
      clearInterval(timer)
      window.removeEventListener("pagehide", leave)
      window.removeEventListener("pageshow", restore)
    }
  }, [heartbeat, save])

  const change = useCallback(
    (kind: "seek" | "options", body: object) => {
      if (!alive.current || unauthorized.current) return
      const revision = ++control.current
      const token = epoch.current
      const lifecycleReady = lifecycleQueue
      changing.current = true
      setLocating(true)
      setError(null)
      // 串行执行已发出的控制请求，忽略连续拖动中的中间请求。
      pending.current = pending.current
        .catch(() => {})
        .then(async () => {
          if (revision !== control.current || token !== epoch.current) return
          if (!current.current) await lifecycleReady.catch(() => {})
          if (revision !== control.current || token !== epoch.current) return
          const value = current.current
          if (!value || unauthorized.current) {
            setLocating(false)
            return
          }
          const next = await api<PlaybackSession>(`/playback/sessions/${value.id}/${kind}`, {
            method: kind === "seek" ? "POST" : "PATCH",
            body: JSON.stringify({ ...body, generation: value.generation, request_id: playbackUuid() }),
          })
          if (revision === control.current && token === epoch.current) accept(next, token)
          else if (
            token === epoch.current &&
            current.current?.id === next.id &&
            next.generation >= current.current.generation
          )
            current.current = next
        })
        .catch((cause) => {
          const authFailure = cause instanceof ApiError && (cause.status === 401 || cause.status === 403)
          if (token === epoch.current && (revision === control.current || authFailure)) {
            setLocating(false)
            fail(cause, token)
          }
        })
        .finally(() => {
          if (revision === control.current && token === epoch.current) changing.current = false
        })
    },
    [accept, fail],
  )

  return {
    session,
    error,
    locating,
    clock,
    setError,
    save,
    heartbeat,
    restart: (position?: number) => {
      restartPosition.current = position ?? clock.current.position
      setAttempt((value) => value + 1)
    },
    seek: (position: number) => {
      clock.current.position = position
      change("seek", { position })
    },
    options: (quality: number, audio_track: number | null) =>
      change("options", { quality, audio_track, position: clock.current.position }),
  }
}
