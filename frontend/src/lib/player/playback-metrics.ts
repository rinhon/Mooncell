import type { PlaybackSession, SeekPath } from "./types"

export type SeekMetric = {
  seekId: number
  mediaId: string
  sessionId: string | null
  generation: number | null
  target: number
  path: SeekPath
  startedAt: number
  controlResponseMs?: number
  firstSegmentMs?: number
  firstFrameMs?: number
  frameSourceTime?: number
  frameEvidence?: "video-frame" | "seeked-fallback"
  status: "pending" | "completed" | "superseded" | "failed"
  backendTimings?: PlaybackSession["timings"]
}

let nextSeekId = 0
const measurements: SeekMetric[] = []
const bindings = new Set<{ element: HTMLElement; mediaId: string; lastSeekId: number }>()
const now = () => performance.now()
const find = (seekId: number) => measurements.find((value) => value.seekId === seekId)

function publish(value: SeekMetric) {
  for (const binding of bindings) {
    const data = binding.element.dataset
    if (
      binding.mediaId !== value.mediaId ||
      value.seekId < binding.lastSeekId ||
      (value.sessionId !== null && value.sessionId !== data.sessionId)
    )
      continue
    binding.lastSeekId = value.seekId
    data.lastSeekId = String(value.seekId)
    data.lastSeekStatus = value.status
    data.lastSeekPath = value.path
    data.lastSeekTarget = String(value.target)
    if (value.controlResponseMs !== undefined) data.lastSeekControlMs = value.controlResponseMs.toFixed(3)
    else delete data.lastSeekControlMs
    if (value.firstSegmentMs !== undefined) data.lastSeekSegmentMs = value.firstSegmentMs.toFixed(3)
    else delete data.lastSeekSegmentMs
    if (value.status === "completed" && value.firstFrameMs !== undefined) {
      data.lastSeekFrameMs = value.firstFrameMs.toFixed(3)
      data.lastSeekSourceTime = String(value.frameSourceTime)
      data.lastSeekEvidence = value.frameEvidence
    } else {
      delete data.lastSeekFrameMs
      delete data.lastSeekSourceTime
      delete data.lastSeekEvidence
    }
  }
}

/** Bind only this mounted player's metrics; old media/session callbacks cannot paint a new player. */
export function bindPlaybackMetrics(element: HTMLElement, mediaId: string) {
  const binding = { element, mediaId, lastSeekId: 0 }
  bindings.add(binding)
  return () => {
    bindings.delete(binding)
  }
}

export function readPlaybackMetrics() {
  return measurements.map((value) => ({
    ...value,
    backendTimings: value.backendTimings && { ...value.backendTimings },
  }))
}

// Read-only snapshots are also available to the browser benchmark without React internals.
if (typeof window !== "undefined") {
  Object.assign(window, {
    __mooncellPlaybackMetrics: {
      read: readPlaybackMetrics,
      clear: () => measurements.splice(0),
    },
  })
}

export function beginSeekMetric(mediaId: string, session: PlaybackSession | null, target: number) {
  const value: SeekMetric = {
    seekId: ++nextSeekId,
    mediaId,
    sessionId: session?.id ?? null,
    generation: session?.generation ?? null,
    target,
    path: "miss",
    startedAt: now(),
    status: "pending",
  }
  measurements.push(value)
  if (measurements.length > 100) measurements.shift()
  publish(value)
  return value.seekId
}

export function setSeekPath(seekId: number, path: SeekPath) {
  const value = find(seekId)
  if (value) {
    value.path = path
    publish(value)
  }
}

export function recordSeekResponse(seekId: number, session: PlaybackSession) {
  const value = find(seekId)
  if (!value) return
  value.sessionId = session.id
  value.generation = session.generation
  value.controlResponseMs = now() - value.startedAt
  value.backendTimings = session.timings
  publish(value)
}

export function recordSeekSegment(seekId: number, session?: PlaybackSession) {
  const value = find(seekId)
  if (!value || value.status !== "pending") return
  value.firstSegmentMs ??= now() - value.startedAt
  if (session?.timings) value.backendTimings = session.timings
  publish(value)
}

export function finishSeekMetric(
  seekId: number,
  sourceTime: number,
  evidence: SeekMetric["frameEvidence"],
  presentedAt = now(),
) {
  const value = find(seekId)
  if (!value || value.status !== "pending") return
  value.firstFrameMs = Math.max(0, presentedAt - value.startedAt)
  value.frameSourceTime = sourceTime
  value.frameEvidence = evidence
  value.status = "completed"
  publish(value)
}

export function cancelSeekMetric(seekId: number, status: "superseded" | "failed" = "superseded") {
  const value = find(seekId)
  if (value?.status === "pending") {
    value.status = status
    publish(value)
  }
}
