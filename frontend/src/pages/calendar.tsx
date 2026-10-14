import { Tabs } from "radix-ui"
import { useToast } from "@/components/ui/toast"
import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronLeft, ChevronRight, Heart, ImageOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react"
import { Skeleton } from "@/components/ui/skeleton"
import { PageHeading } from "@/components/page-heading"
import { api } from "@/lib/api"
import { mikanSearchUrl } from "@/lib/mikan"
import "./calendar.css"
import { useOverflowMenu } from "@/hooks/use-overflow-menu"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu"

type CalendarItem = { liked: boolean; id: number; title: string; weekday: number | null; broadcast_time: string; cover_url: string | null }
type SeasonCalendar = { season: string; current_season: string; source_url: string; fetched_at: string; items: CalendarItem[] }
const weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日", "其他放送"]
function CalendarSkeleton({ dayValue, count = 8, showTabs = true }: { dayValue?: string; count?: number; showTabs?: boolean }) {
  return <div role="status" aria-label="正在加载季度日历" aria-busy="true">
    <span className="sr-only">正在读取季度日历，首次获取可能需要一些时间。</span>
    <div aria-hidden="true">
      {showTabs && <div className="calendar-week-tabs calendar-skeleton-tabs">{weekdays.map((day, index) => <div key={day} className="calendar-week-tab" data-state={dayValue === String(index) ? "active" : "inactive"}><span className="calendar-week-label">{day}</span><Skeleton className="calendar-week-count calendar-skeleton-count"/></div>)}</div>}
      <div className="calendar-items calendar-day-grid">{Array.from({ length: count }, (_, index) => <div className="calendar-item" key={index}>
        <div className="calendar-artwork"><Skeleton className="calendar-cover"/><span className="calendar-skeleton-favorite"/></div>
        <div className="calendar-item-copy"><Skeleton className="calendar-time calendar-skeleton-time"/><div className="calendar-skeleton-title"><Skeleton/><Skeleton style={{ width: index % 2 ? "58%" : "76%" }}/></div></div>
      </div>)}</div>
    </div>
  </div>
}
function CalendarWeekTabs({ items, dayValue, onDayChange }: { items: CalendarItem[]; dayValue: string; onDayChange: (value: string) => void }) {
  const highlightWidth = 100
  const listRef = useRef<HTMLDivElement>(null)
  const { measureRef, visibleCount } = useOverflowMenu(listRef, weekdays.length)
  const [indicator, setIndicator] = useState({ left: 0, width: 0, ready: false })
  const measureIndicator = useCallback(() => {
    const tab = listRef.current?.querySelector<HTMLButtonElement>('[role="tab"][data-state="active"]:not([hidden])')
    if (tab) setIndicator({ left: tab.offsetLeft, width: tab.offsetWidth, ready: true })
    else setIndicator(previous => ({ ...previous, ready: false }))
  }, [])
  useLayoutEffect(() => { measureIndicator() }, [dayValue, visibleCount, measureIndicator])
  const hoveredTab = useRef<HTMLButtonElement | null>(null)
  const [hover, setHover] = useState({ left: 0, width: 0, visible: false })
  const moveHover = useCallback((tab: HTMLButtonElement) => {
    hoveredTab.current = tab
    setHover({ left: tab.offsetLeft, width: tab.offsetWidth, visible: true })
  }, [])
  function hideHover() {
    hoveredTab.current = null
    setHover(previous => ({ ...previous, visible: false }))
  }
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const observer = new ResizeObserver(() => {
      measureIndicator()
      if (hoveredTab.current) moveHover(hoveredTab.current)
    })
    observer.observe(list)
    for (const tab of list.querySelectorAll<HTMLButtonElement>('[role="tab"]')) observer.observe(tab)
    return () => observer.disconnect()
  }, [moveHover, measureIndicator])
  return <Tabs.List ref={listRef} className="calendar-week-tabs calendar-week-tabs-indicated" aria-label="选择播出星期" onPointerLeave={hideHover} onPointerCancel={hideHover}>
    <motion.span initial={false} aria-hidden="true" className="calendar-week-indicator" animate={{ x: indicator.left, scaleX: indicator.width / highlightWidth }} transition={{ type: "spring", stiffness: 400, damping: 32 }} style={{ width: highlightWidth, transformOrigin: "left", visibility: indicator.ready ? "visible" : "hidden" }}/>
    <motion.span initial={false} aria-hidden="true" className="calendar-week-hover" data-visible={hover.visible} animate={{ x: hover.left, scaleX: hover.width / highlightWidth }} transition={{ type: "spring", stiffness: 400, damping: 32 }} style={{ width: highlightWidth, transformOrigin: "left" }}/>
    <div ref={measureRef} className="overflow-measure" aria-hidden="true" inert>{weekdays.map((day, index) => <span className="calendar-week-tab" key={day}><span className="calendar-week-label">{day}</span><span className="calendar-week-count">{items.filter(item => index === 7 ? item.weekday === null : item.weekday === index).length}</span></span>)}</div>
    {weekdays.map((day, index) => <Tabs.Trigger key={day} value={String(index)} hidden={index >= visibleCount} className="calendar-week-tab" onPointerEnter={event => {
      if (event.pointerType === "mouse") moveHover(event.currentTarget)
    }}><span className="calendar-week-label">{day}</span><span className="calendar-week-count">{items.filter(item => index === 7 ? item.weekday === null : item.weekday === index).length}</span></Tabs.Trigger>)}
    {visibleCount < weekdays.length && <DropdownMenu><DropdownMenuTrigger asChild><button className="calendar-week-tab overflow-trigger" data-state={Number(dayValue) >= visibleCount ? "active" : "inactive"} aria-label="更多星期" onPointerEnter={hideHover}><span className="calendar-week-label">{Number(dayValue) >= visibleCount ? weekdays[Number(dayValue)] : "更多"}</span><span className="calendar-week-count" aria-hidden="true">▾</span></button></DropdownMenuTrigger><DropdownMenuContent align="end">{weekdays.slice(visibleCount).map((day, offset) => {
      const index = visibleCount + offset
      return <DropdownMenuItem key={day} onSelect={() => onDayChange(String(index))}><span className="calendar-week-label">{day}</span><span className="calendar-week-count">{items.filter(item => index === 7 ? item.weekday === null : item.weekday === index).length}</span>{dayValue === String(index) && <span aria-hidden="true">✓</span>}</DropdownMenuItem>
    })}</DropdownMenuContent></DropdownMenu>}
  </Tabs.List>
}
function shiftSeason(season: string, offset: number) {
  const date = new Date(Number(season.slice(0, 4)), Number(season.slice(4)) - 1 + offset * 3, 1)
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}`
}
function Cover({ item, onReady }: { item: CalendarItem; onReady: (url: string) => void }) {
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const url = item.cover_url
  const failed = Boolean(url && failedUrl === url)
  const loading = Boolean(url && !failed && loadedUrl !== url)
  useEffect(() => {
    if (url && !loading) onReady(url)
  }, [url, loading, onReady])
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
    {loading && <Skeleton className="calendar-cover-skeleton"/>}
    {url && !failed ? <img key={url} ref={imageRef} src={url} alt={item.title} loading="eager" decoding="async" style={{ opacity: loading ? 0 : 1 }} onLoad={(event) => void reveal(event.currentTarget)} onError={() => setFailedUrl(url)} /> : <ImageOff size={24} strokeWidth={1} aria-label="暂无封面" />}
  </div>
}
// Each mounted day owns its loading state, including while it slides out.
function CalendarDayContent({ items, children }: { items: CalendarItem[]; children: (onReady: (url: string) => void) => ReactNode }) {
  const coverUrls = [...new Set(items.flatMap(item => item.cover_url ? [item.cover_url] : []))].sort()
  const coverBatch = JSON.stringify(coverUrls)
  const [readyCovers, setReadyCovers] = useState<{ batch: string; urls: Set<string> }>({ batch: "", urls: new Set() })
  const markCoverReady = useCallback((url: string) => {
    setReadyCovers(previous => {
      const urls = previous.batch === coverBatch ? previous.urls : new Set<string>()
      if (previous.batch === coverBatch && urls.has(url)) return previous
      return { batch: coverBatch, urls: new Set([...urls, url]) }
    })
  }, [coverBatch])
  const pending = coverUrls.length > 0 && (readyCovers.batch !== coverBatch || coverUrls.some(url => !readyCovers.urls.has(url)))
  return <>
    {pending && <CalendarSkeleton showTabs={false} count={items.length}/>}
    <div className="calendar-items calendar-day-grid" style={pending ? { display: "none" } : undefined}>
      {children(markCoverReady)}
    </div>
  </>
}
const dayVariants = {
  enter: (direction: number) => ({ x: `${direction * 100}%`, opacity: direction ? .4 : 1 }),
  active: { x: "0%", opacity: 1 },
  exit: (direction: number) => ({ x: `${direction * -100}%`, opacity: direction ? .4 : 1 }),
}
const CalendarDayPanel = forwardRef<HTMLDivElement, { value: string; direction: number; children: ReactNode }>(function CalendarDayPanel({ value, direction, children }, ref) {
  const present = useIsPresent()
  const reducedMotion = useReducedMotion()
  return <Tabs.Content value={value} forceMount asChild ref={ref}>
    <motion.div className="calendar-day calendar-day-panel" custom={direction} variants={dayVariants} initial="enter" animate="active" exit="exit" transition={reducedMotion ? { duration: 0 } : { type: "spring", stiffness: 400, damping: 30 }} inert={!present || undefined} aria-hidden={!present || undefined} style={{ pointerEvents: present ? undefined : "none" }}>{children}</motion.div>
  </Tabs.Content>
})

export function CalendarPage() {
  const reducedMotion = useReducedMotion()
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
  const [dayDirection, setDayDirection] = useState(0)
  function changeDay(value: string) {
    if (value === dayValue) return
    const panels = panelsRef.current
    if (panels) {
      // Keep the document tall enough for the current scroll position when the next day is shorter.
      setPanelMinHeight(Math.max(0, window.innerHeight - panels.getBoundingClientRect().top))
    }
    setDayDirection(Number(value) > Number(dayValue) ? 1 : -1)
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
      <div><h2>{season ? `${season.slice(0, 4)} 年 ${Number(season.slice(4))} 月新番` : "当季新番"}</h2>{data ? <p>{data.items.length} 部 · 已保存至本地 · <a href={data.source_url} target="_blank" rel="noreferrer">来源 yuc.wiki</a></p> : query.isPending ? <Skeleton className="calendar-skeleton-meta mt-2"/> : null}</div>
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
      <Tabs.Root value={dayValue} onValueChange={changeDay} className="calendar-tabs">
        <CalendarWeekTabs items={data.items} dayValue={dayValue} onDayChange={changeDay}/>
        <div ref={panelsRef} className="calendar-panels" style={{ minHeight: panelMinHeight }}><AnimatePresence mode="popLayout" custom={reducedMotion ? 0 : dayDirection}>{weekdays.map((day, index) => {
        if (dayValue !== String(index)) return null
        const items = data.items.filter(item => index === 7 ? item.weekday === null : item.weekday === index).sort((a, b) => Number(Boolean(b.liked)) - Number(Boolean(a.liked)))
        return <CalendarDayPanel value={String(index)} direction={reducedMotion ? 0 : dayDirection} key={`${data.season}-${day}`}><CalendarDayContent key={`${data.season}-${index}`} items={items}>{markCoverReady => items.length ? items.map(item => <article className="calendar-item" key={`${data.season}-${item.id}`}><div className="calendar-artwork"><a className="calendar-search-link" href={mikanSearchUrl(item.title)} target="_blank" rel="noopener noreferrer" aria-label={`在蜜柑计划搜索：${item.title}（新标签页）`} title={`在蜜柑计划搜索：${item.title}`}><Cover item={item} onReady={markCoverReady} /></a><button type="button" className="calendar-favorite" aria-pressed={Boolean(item.liked)} aria-label={`${item.liked ? "取消喜欢" : "喜欢"}：${item.title}`} title={item.liked ? "取消喜欢" : "喜欢并置顶"} aria-disabled={pendingFavorites.current.has(`${data.season}-${item.id}`)} onClick={() => toggleFavorite(data.season, item)}><Heart size={17} fill={item.liked ? "currentColor" : "none"}/></button></div><div className="calendar-item-copy"><p className="calendar-time">{item.broadcast_time}</p><h4 title={item.title}><a className="calendar-title-link" href={mikanSearchUrl(item.title)} target="_blank" rel="noopener noreferrer" aria-label={`在蜜柑计划搜索：${item.title}（新标签页）`}>{item.title}</a></h4></div></article>) : <p className="calendar-empty">暂无播出安排</p>}</CalendarDayContent></CalendarDayPanel>
      })}</AnimatePresence></div></Tabs.Root></>}
  </>
}
