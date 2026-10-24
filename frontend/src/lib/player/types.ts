import type { PlaybackProgress } from "@/lib/api"

export type PlaybackInfo = {
  media_id: string
  source_id: number
  filename: string
  version: string
  duration: number
  video_width: number
  video_height: number
  video_codec: string
  hdr: boolean
  supported: boolean
  unsupported_reason: string | null
  qualities: number[]
  audio_tracks: { id: number; codec: string; language: string | null; title: string | null; default: boolean }[]
  subtitle_tracks: {
    id: string
    codec: string
    language: string | null
    title: string | null
    supported: boolean
    reason: string | null
    url: string | null
  }[]
  progress: PlaybackProgress | null
  native_mime_type?: string | null
  hls_mime_type?: string | null
  frame_rate?: number
}

export type PlaybackSession = {
  id: string
  media_id: string
  generation: number
  status: "preparing" | "ready" | "paused" | "failed" | "closed"
  duration: number
  source_anchor: number
  media_anchor: number
  playlist_url: string | null
  quality: number
  audio_track: number | null
  cached_ranges: [number, number][]
  segments: { sequence: number; source_start: number; duration: number }[]
  error: { code: string; message: string } | null
  process_state: string
  position?: number
  playback_mode?: "direct" | "remux" | "transcode"
  stream_url?: string
  mode_reason?: string
  mime_type?: string
  timeline_mode?: "source" | "anchored"
  revision?: number
  seek_revision?: number
  seek_disposition?: "buffered" | "server-cache" | "restart" | null
  requires_reload?: boolean
  needs_recovery?: boolean
  timings?: {
    stop_ms: number | null
    spawn_ms: number | null
    first_segment_ms: number | null
    ready_ms: number | null
  }
}

export type SeekPath = "buffered" | "server-cache" | "miss"

export function clampTime(value: number, duration: number) {
  return Number.isFinite(value) ? Math.min(Math.max(0, value), Math.max(0, duration)) : 0
}

export function sourceTime(mediaTime: number, sourceAnchor: number, mediaAnchor: number, duration: number) {
  return clampTime(sourceAnchor + mediaTime - mediaAnchor, duration)
}

export function formatTime(value: number) {
  const seconds = Math.floor(Math.max(0, Number.isFinite(value) ? value : 0))
  const hours = Math.floor(seconds / 3600)
  return `${hours ? `${hours}:` : ""}${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
}
