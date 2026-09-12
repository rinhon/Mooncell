import { Tabs } from "radix-ui"
import { useToast } from "@/components/ui/toast"
import { useEffect, useRef, useState } from "react"
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronLeft, ChevronRight, Heart, ImageOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { PageHeading } from "@/components/page-heading"
import { api } from "@/lib/api"
import "./calendar.css"

type CalendarItem = { liked: boolean; id: number; title: string; weekday: number | null; broadcast_time: string; cover_url: string | null }
type SeasonCalendar = { season: string; current_season: string; source_url: string; fetched_at: string; items: CalendarItem[] }
const weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日", "其他放送"]
function CalendarSkeleton({ dayValue }: { dayValue: string }) {
  return <div role="status" aria-label="正在加载季度日历" aria-busy="true">
    <span className="sr-only">正在读取季度日历，首次获取可能需要一些时间。</span>
    <div aria-hidden="true">
      <div className="calendar-week-tabs calendar-skeleton-tabs">{weekdays.map((day, index) => <span key={day} className="calendar-week-tab" data-state={dayValue === String(index) ? "active" : "inactive"}>{day}<span className="calendar-skeleton calendar-skeleton-count"/></span>)}</div>
      <div className="calendar-items calendar-day-grid">{Array.from({ length: 8 }, (_, index) => <div className="calendar-item" key={index}>
        <div className="calendar-artwork"><div className="calendar-cover calendar-skeleton"/><span className="calendar-skeleton-favorite"/></div>
        <div className="calendar-item-copy"><div className="calendar-time calendar-skeleton calendar-skeleton-time"/><div className="calendar-skeleton-title"><span className="calendar-skeleton"/><span className="calendar-skeleton" style={{ width: index % 2 ? "58%" : "76%" }}/></div></div>
      </div>)}</div>
    </div>
  </div>
}
function shiftSeason(season: string, offset: number) {
  const date = new Date(Number(season.slice(0, 4)), Number(season.slice(4)) - 1 + offset * 3, 1)
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}`
}
function Cover({ item }: { item: CalendarItem }) {
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const url = item.cover_url
  const failed = Boolean(url && failedUrl === url)
  const loading = Boolean(url && !failed && loadedUrl !== url)
  async function reveal(image: HTMLImageElement) {
    const source = url
    try {
      await image.decode()
      if (imageRef.current === image && image.getAttribute("src") === source) setLoadedUrl(source)
    } catch {
      if (imageRef.current === image && image.getAttribute("src") === source) setFailedUrl(source)
    }
  }
  return <div className="calendar-cover" aria-busy={loading}>
    {loading && <div className="calendar-cover-skeleton calendar-skeleton" aria-hidden="true"/>}
    {url && !failed ? <img key={url} ref={imageRef} src={url} alt={item.title} loading="lazy" decoding="async" style={{ opacity: loading ? 0 : 1 }} onLoad={(event) => void reveal(event.currentTarget)} onError={() => setFailedUrl(url)} /> : <ImageOff size={24} strokeWidth={1} aria-label="暂无封面" />}
  </div>
}
export function CalendarPage() {
  const [now, setNow] = useState(() => new Date())
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const panelsRef = useRef<HTMLDivElement>(null)
  const [panelMinHeight, setPanelMinHeight] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  const today = (now.getDay() + 6) % 7
  const dayValue = selectedDay ?? String(today)
  const [dayTransition, setDayTransition] = useState<{ from: string; direction: "next" | "previous" } | null>(null)
  function changeDay(value: string) {
    if (value === dayValue) return
    const panels = panelsRef.current
    if (panels) {
      // Keep the document tall enough for the current scroll position when the next day is shorter.
      setPanelMinHeight(Math.max(0, window.innerHeight - panels.getBoundingClientRect().top))
    }
    setDayTransition({ from: dayValue, direction: Number(value) > Number(dayValue) ? "next" : "previous" })
    setSelectedDay(value)
  }
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<string | null>(null)
  const savingFavorites = useIsMutating({ mutationKey: ["calendar-favorite"] })
  const pendingFavorites = useRef(new Set<string>())
  const query = useQuery({ queryKey: ["season-calendar", selected], queryFn: () => api<SeasonCalendar>(`/calendar${selected ? `?season=${selected}` : ""}`), staleTime: 60_000, refetchInterval: savingFavorites ? false : 60_000, refetchOnWindowFocus: !savingFavorites, retry: false })
  const toast = useToast()
  function updateFavorite(input: { season: string; id: number; liked: boolean }) {
    queryClient.setQueriesData<SeasonCalendar>({ queryKey: ["season-calendar"] }, old => old?.season === input.season ? { ...old, items: old.items.map(item => item.id === input.id ? { ...item, liked: input.liked } : item) } : old)
  }
  const favorite = useMutation({
    mutationKey: ["calendar-favorite"],
    mutationFn: (input: { season: string; id: number; liked: boolean }) => api(`/calendar/${input.season}/items/${input.id}/favorite`, { method: "PUT", body: JSON.stringify({ liked: input.liked }) }),
    onMutate: (input) => {
      void queryClient.cancelQueries({ queryKey: ["season-calendar"] })
      updateFavorite(input)
    },
    onError: (error, input) => {
      // 仅回退失败的卡片，不覆盖其他同时保存的收藏。
      updateFavorite({ ...input, liked: !input.liked })
      toast("喜欢状态保存失败", { description: error.message, tone: "error" })
    },
    onSettled: (_result, _error, input) => {
      pendingFavorites.current.delete(`${input.season}-${input.id}`)
      if (queryClient.isMutating({ mutationKey: ["calendar-favorite"] }) === 1) {
        void queryClient.invalidateQueries({ queryKey: ["season-calendar"] })
      }
    },
  })
  function toggleFavorite(season: string, item: CalendarItem) {
    const key = `${season}-${item.id}`
    if (pendingFavorites.current.has(key)) return
    pendingFavorites.current.add(key)
    favorite.mutate({ season, id: item.id, liked: !item.liked })
  }
  const data = query.data
  const season = selected ?? data?.season
  const current = data?.current_season ?? queryClient.getQueryData<SeasonCalendar>(["season-calendar", null])?.current_season
  return <>
    <PageHeading eyebrow="Season calendar" title="追番日历" description="每年 1、4、7、10 月收录当季新番，按星期查看播出安排。" />
    <div className="calendar-toolbar">
      <div><h2>{season ? `${season.slice(0, 4)} 年 ${Number(season.slice(4))} 月新番` : "当季新番"}</h2>{data ? <p>{data.items.length} 部 · 已保存至本地 · <a href={data.source_url} target="_blank" rel="noreferrer">来源 yuc.wiki</a></p> : query.isPending ? <p aria-hidden="true"><span className="calendar-skeleton calendar-skeleton-meta"/></p> : null}</div>
      <div className="calendar-navigation">
        <Button size="icon" variant="ghost" aria-label="上一季度" disabled={!season || season <= "200001"} onClick={() => season && setSelected(shiftSeason(season, -1))}><ChevronLeft size={18} /></Button>
        <Button variant="ghost" onClick={() => setSelected(null)} disabled={selected === null}>当季</Button>
        <Button size="icon" variant="ghost" aria-label="下一季度" disabled={!season || !current || season >= current} onClick={() => season && setSelected(shiftSeason(season, 1))}><ChevronRight size={18} /></Button>
      </div>
    </div>
    {query.isError && <div className="calendar-message" role="alert"><p>{query.error.message}</p><Button variant="secondary" onClick={() => query.refetch()}>重新读取</Button></div>}
    {(data || query.isPending) && <><p className="calendar-note">时间按源站原文展示；24:00 及之后表示该播出日的次日凌晨。实际播出以官方安排为准。</p>
      <p className="calendar-today">今天是 {now.getFullYear()} 年 {now.getMonth() + 1} 月 {now.getDate()} 日 · {weekdays[today]}</p>
    </>}
    {query.isPending && <CalendarSkeleton dayValue={dayValue}/>}
    {data && <>
      <Tabs.Root value={dayValue} onValueChange={changeDay} className="calendar-tabs" data-slide-direction={dayTransition?.direction}>
        <Tabs.List className="calendar-week-tabs" aria-label="选择播出星期">{weekdays.map((day, index) => <Tabs.Trigger key={day} value={String(index)} className="calendar-week-tab">{day}<span>{data.items.filter(item => index === 7 ? item.weekday === null : item.weekday === index).length}</span></Tabs.Trigger>)}</Tabs.List>
        <div ref={panelsRef} className="calendar-panels" style={{ minHeight: panelMinHeight }}>{weekdays.map((day, index) => {
        const items = data.items.filter(item => index === 7 ? item.weekday === null : item.weekday === index).sort((a, b) => Number(Boolean(b.liked)) - Number(Boolean(a.liked)))
        const exiting = dayTransition?.from === String(index) && dayValue !== String(index)
        return <Tabs.Content value={String(index)} forceMount={exiting ? true : undefined} inert={exiting || undefined} aria-hidden={exiting || undefined} data-exiting={exiting || undefined} onAnimationEnd={(event) => {
          if (event.target === event.currentTarget && exiting) setDayTransition(old => old?.from === String(index) ? null : old)
        }} className="calendar-day calendar-day-panel" key={day}><div className="calendar-items calendar-day-grid">{items.length ? items.map(item => <article className="calendar-item" key={`${data.season}-${item.id}`}><div className="calendar-artwork"><Cover item={item} /><button type="button" className="calendar-favorite" aria-pressed={Boolean(item.liked)} aria-label={`${item.liked ? "取消喜欢" : "喜欢"}：${item.title}`} title={item.liked ? "取消喜欢" : "喜欢并置顶"} aria-disabled={pendingFavorites.current.has(`${data.season}-${item.id}`)} onClick={() => toggleFavorite(data.season, item)}><Heart size={17} fill={item.liked ? "currentColor" : "none"}/></button></div><div className="calendar-item-copy"><p className="calendar-time">{item.broadcast_time}</p><h4 title={item.title}>{item.title}</h4></div></article>) : <p className="calendar-empty">暂无播出安排</p>}</div></Tabs.Content>
      })}</div></Tabs.Root></>}
  </>
}
