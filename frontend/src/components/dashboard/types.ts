import type { Dashboard, ParsedRelease } from "@/lib/api"

// 后端 recent_items.parsed、publishedAt 均允许 null，保留真实接口的可空性。
export type RecentRelease = {
  id: number
  title: string
  status: string
  publishedAt: string | null
  parsed: ParsedRelease | null
}
export type DashboardSummary = Omit<Dashboard, "recent_items"> & { recent_items: RecentRelease[] }
export type CalendarItem = {
  liked: boolean
  id: number
  title: string
  weekday: number | null
  broadcast_time: string
  cover_url: string | null
}
export type SeasonCalendar = {
  season: string
  current_season: string
  source_url: string
  fetched_at: string
  items: CalendarItem[]
}
export type ModuleQuery<T> = {
  data: T | undefined
  isPending: boolean
  isError: boolean
  error: Error | null
  refetch: () => unknown
}

export function formatSpeed(value: number) {
  const units = ["B", "KB", "MB", "GB"]
  const safe = Math.max(0, Number.isFinite(value) ? value : 0)
  const unit = safe ? Math.min(Math.floor(Math.log(safe) / Math.log(1024)), units.length - 1) : 0
  return `${(safe / 1024 ** unit).toFixed(unit > 1 ? 1 : 0)} ${units[unit]}/s`
}
