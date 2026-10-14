/** 前端唯一的 HTTP 入口：统一 API 前缀、Cookie 携带和错误结构。 */
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  // 开发环境由 Vite 代理，生产环境由 Nginx 代理，因此前端始终使用同源相对地址。
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new ApiError(response.status, body?.detail ?? "请求失败")
  }
  return response.json() as Promise<T>
}

export type AuthStatus = { initialized: boolean; authenticated: boolean; username?: string }
export type Feed = {
  excluded_keywords: string[]
  id: number; name: string; url: string; kind: "mikan" | "standard"; season?: number | null; active: boolean
  refresh_interval_minutes: number; connection_status: string; last_checked_at?: string; last_error?: string
  show_metadata?: TmdbMetadata
}
export type FeedInspection = { raw_title: string; name: string; kind: "mikan" | "standard"; entries: number }
export type TmdbCandidate = {
  tmdb_id: number; media_type: "tv" | "movie"; title: string; original_title?: string
  release_date?: string; overview?: string; poster_url?: string; href: string
}
export type TmdbMetadata = {
  tmdb_id: number; media_type: "tv" | "movie"; title: string; overview?: string
  poster_url?: string; release_date?: string; genres?: string[]; episode_count?: number
  rating?: number; vote_count?: number; href: string
}
export type Show = {
  artwork_version?: string | null
  tmdb_url?: string | null
  id: number; name: string; active: boolean; created_at: string
  tmdb_id?: number; media_type?: string; metadata_title?: string; overview?: string
  release_date?: string; episode_count?: number; rating?: number; poster_url?: string
  discovered_items: number; artwork_status: "missing" | "pending" | "completed" | "partial" | "failed"
  poster_ready: boolean; fanart_ready: boolean; clearlogo_ready: boolean
}
export type Downloader = {
  id: number; name: string; kind: "qbittorrent" | "aria2"; base_url: string
  username?: string; active: boolean; connection_status: string; last_error?: string
}
export type ParsedRelease = {
  raw_title: string; title?: string; release_group?: string; media_type: string; release_kind: string
  season?: number; episode_start?: number; episode_end?: number; revision: number; resolution?: string
  sources: string[]; subtitle_languages: string[]; video_codecs: string[]; audio_codecs: string[]
  container?: string; confidence: number; evidence: string[]; warnings: string[]
}
export type Dashboard = {
  feeds: number; healthy_feeds: number; discovered_items: number; needs_review: number
  downloaders: number; healthy_downloaders: number
  recent_items: Array<{ id: number; title: string; status: string; publishedAt?: string; parsed: ParsedRelease }>
}
export type LogEntry = {
  id: number; occurred_at: string; level: "info" | "warning" | "error"
  scope: string; event_type: string; message: string
}
export type DownloadTask = {
  review_required?: boolean
  source_id: number
  automation_state?: string | null
  automation_error?: string | null
  id: number; title: string; source_name: string; download_url: string; info_hash?: string
  published_at?: string; discovered_at: string; matched: boolean; status: string; qb_state?: string
  progress: number; download_speed: number; upload_speed: number; eta?: number
  size: number; downloaded: number
}
export type DownloadCenter = {
  downloader_configured: boolean; downloader_online: boolean; downloader_name?: string
  downloader_version?: string; download_speed: number; upload_speed: number; error?: string
  tasks: DownloadTask[]
}
