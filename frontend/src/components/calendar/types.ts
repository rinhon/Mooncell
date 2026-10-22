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
