import type { ReactNode } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { PageHeading } from "@/components/page-heading"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import "@/pages/calendar.css"

export const calendarWeekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日", "其他放送"]

export function CalendarHeader({ now, season, metadata, navigation, showNotes = true }: {
  now: Date
  season?: string
  metadata: ReactNode
  navigation: ReactNode
  showNotes?: boolean
}) {
  const today = (now.getDay() + 6) % 7
  return <>
    <PageHeading eyebrow="Season calendar" title="追番日历" description="每年 1、4、7、10 月收录当季新番，按星期查看播出安排。"/>
    <div className="calendar-toolbar">
      <div><h2>{season ? `${season.slice(0, 4)} 年 ${Number(season.slice(4))} 月新番` : "当季新番"}</h2>{metadata}</div>
      <div className="calendar-navigation">{navigation}</div>
    </div>
    {showNotes && <>
      <p className="calendar-note">时间按源站原文展示；24:00 及之后表示该播出日的次日凌晨。实际播出以官方安排为准。</p>
      <p className="calendar-today">今天是 {now.getFullYear()} 年 {now.getMonth() + 1} 月 {now.getDate()} 日 · {calendarWeekdays[today]}</p>
    </>}
  </>
}

export function CalendarSkeleton({ dayValue, count = 8, showTabs = true }: { dayValue?: string; count?: number; showTabs?: boolean }) {
  return <div role="status" aria-label="正在加载季度日历" aria-busy="true">
    <span className="sr-only">正在读取季度日历，首次获取可能需要一些时间。</span>
    <div aria-hidden="true">
      {showTabs && <div className="calendar-week-tabs calendar-skeleton-tabs">{calendarWeekdays.map((day, index) => <div key={day} className="calendar-week-tab" data-state={dayValue === String(index) ? "active" : "inactive"}><span className="calendar-week-label">{day}</span><Skeleton className="calendar-week-count calendar-skeleton-count"/></div>)}</div>}
      <div className="calendar-items calendar-day-grid">{Array.from({ length: count }, (_, index) => <div className="calendar-item" key={index}>
        <div className="calendar-artwork"><Skeleton className="calendar-cover"/><span className="calendar-skeleton-favorite"/></div>
        <div className="calendar-item-copy"><Skeleton className="calendar-time calendar-skeleton-time"/><div className="calendar-skeleton-title"><Skeleton/><Skeleton style={{ width: index % 2 ? "58%" : "76%" }}/></div></div>
      </div>)}</div>
    </div>
  </div>
}

/** Keep the route, data and cover loading states in the same calendar layout. */
export function CalendarLoading({ now = new Date(), season, dayValue }: { now?: Date; season?: string; dayValue?: string }) {
  return <>
    <CalendarHeader now={now} season={season} metadata={<Skeleton className="calendar-skeleton-meta mt-2"/>} navigation={<>
      <Button size="icon" variant="ghost" aria-label="上一季度" disabled><ChevronLeft size={18}/></Button>
      <Button variant="ghost" disabled>当季</Button>
      <Button size="icon" variant="ghost" aria-label="下一季度" disabled><ChevronRight size={18}/></Button>
    </>}/>
    <CalendarSkeleton dayValue={dayValue ?? String((now.getDay() + 6) % 7)}/>
  </>
}
