import { Tabs } from "radix-ui"
import { useCallback, useEffect, useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useSearchParams } from "react-router-dom"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Masonry } from "@/components/ui/masonry"
import ClickSpark from "@/components/click-spark"
import { useReducedMotion } from "motion/react"
import { CalendarHeader, CalendarLoading } from "@/components/calendar-loading"
import { CalendarItemCard } from "@/components/calendar/calendar-item-card"
import { CalendarWeekTabs } from "@/components/calendar/calendar-week-tabs"
import { usePageLoadCycle, usePageReady } from "@/components/page-load-boundary"
import { useCalendarFavorite } from "@/components/calendar/use-calendar-favorite"
import type { CalendarItem, SeasonCalendar } from "@/components/calendar/types"
import { api } from "@/lib/api"
import { useTheme } from "@/lib/theme"

function shiftSeason(season: string, offset: number) {
  const date = new Date(Number(season.slice(0, 4)), Number(season.slice(4)) - 1 + offset * 3, 1)
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}`
}
export function CalendarPage() {
  const { palette } = useTheme()
  const reducedMotion = useReducedMotion()
  const pageReady = usePageReady()
  const [now, setNow] = useState(() => new Date())
  const [searchParams] = useSearchParams()
  const [selectedDay, setSelectedDay] = useState<string | null>(() => {
    const day = searchParams.get("day")
    return day && /^[0-7]$/.test(day) ? day : null
  })
  const panelsRef = useRef<HTMLDivElement>(null)
  const [panelMinHeight, setPanelMinHeight] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  const today = (now.getDay() + 6) % 7
  const dayValue = selectedDay ?? String(today)
  const [entryState, setEntryState] = useState<{ key: string; animating: boolean } | null>(null)
  const entryLockRef = useRef(true)
  const awaitingLoadStartRef = useRef(false)
  const pendingDayRef = useRef<string | null>(null)
  const activeDayRef = useRef(dayValue)
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<string | null>(null)
  const { sparksRef, savingFavorites, favoriteOrder, toggleFavorite, isFavoriteBusy } =
    useCalendarFavorite(reducedMotion)
  const query = useQuery({
    queryKey: ["season-calendar", selected],
    queryFn: () => api<SeasonCalendar>(`/calendar${selected ? `?season=${selected}` : ""}`),
    staleTime: 60_000,
    refetchInterval: savingFavorites ? false : 60_000,
    refetchOnWindowFocus: !savingFavorites,
    retry: false,
  })
  const data = query.data
  const entryKey = `${data?.season ?? "pending"}:${dayValue}`
  const activeEntryKey = useRef(entryKey)
  activeEntryKey.current = entryKey
  const dayItems = (data?.items ?? [])
    .filter((item) => (dayValue === "7" ? item.weekday === null : item.weekday === Number(dayValue)))
    .sort((a, b) => {
      const liked = (item: CalendarItem) => favoriteOrder[`${data?.season}-${item.id}`] ?? item.liked
      return Number(Boolean(liked(b))) - Number(Boolean(liked(a)))
    })
  // 新日期的首轮渲染仍可能读到上一周期的 ready，先等本轮加载真正开始。
  if (!pageReady) awaitingLoadStartRef.current = false
  const entryBusy =
    awaitingLoadStartRef.current ||
    !pageReady ||
    (!reducedMotion && dayItems.length > 0 && (entryState?.key !== entryKey || entryState.animating))
  entryLockRef.current = entryBusy
  activeDayRef.current = dayValue
  const switchDay = useCallback((value: string) => {
    // 同一帧内的下一次输入也要进入缓冲，不能中断刚开始的切换。
    entryLockRef.current = true
    awaitingLoadStartRef.current = true
    activeDayRef.current = value
    const panels = panelsRef.current
    if (panels) setPanelMinHeight(Math.max(0, window.innerHeight - panels.getBoundingClientRect().top))
    setSelectedDay(value)
  }, [])
  function changeDay(value: string) {
    if (value === activeDayRef.current || pendingDayRef.current !== null) return
    if (entryLockRef.current) {
      // 只保留首条预输入，连续点击不覆盖，也不累积成队列。
      pendingDayRef.current = value
      return
    }
    switchDay(value)
  }
  useEffect(() => {
    if (entryBusy || entryLockRef.current || pendingDayRef.current === null) return
    const value = pendingDayRef.current
    pendingDayRef.current = null
    if (value !== activeDayRef.current) switchDay(value)
  }, [entryBusy, dayValue, switchDay])
  function changeSeason(value: string | null) {
    pendingDayRef.current = null
    setSelected(value)
  }
  const season = selected ?? data?.season
  const current =
    data?.current_season ?? queryClient.getQueryData<SeasonCalendar>(["season-calendar", null])?.current_season
  usePageLoadCycle(
    `${selected ?? data?.season ?? "pending"}:${dayValue}`,
    <CalendarLoading
      now={now}
      season={season}
      dayValue={dayValue}
      tabs={
        <Tabs.Root value={dayValue} onValueChange={changeDay} className="calendar-tabs">
          <CalendarWeekTabs items={data?.items ?? []} dayValue={dayValue} onDayChange={changeDay} busy />
        </Tabs.Root>
      }
    />,
    true,
  )
  if (query.isPending) return <CalendarLoading now={now} season={season} dayValue={dayValue} />
  return (
    <ClickSpark
      ref={sparksRef}
      manual
      disabled={Boolean(reducedMotion)}
      sparkColor={palette.ink}
      sparkCount={8}
      sparkSize={11}
      sparkRadius={30}
      sparkWidth={2}
      duration={500}
      glow={0.2}
      style={{ height: "auto" }}
      className="calendar-sparks"
    >
      <CalendarHeader
        now={now}
        season={season}
        showNotes={Boolean(data)}
        metadata={
          data ? (
            <p>
              {data.items.length} 部 · 已保存至本地 ·{" "}
              <a href={data.source_url} target="_blank" rel="noreferrer">
                来源 yuc.wiki
              </a>
            </p>
          ) : null
        }
        navigation={
          <>
            <Button
              size="icon"
              variant="ghost"
              aria-label="上一季度"
              disabled={!season || season <= "200001"}
              onClick={() => season && changeSeason(shiftSeason(season, -1))}
            >
              <ChevronLeft size={18} />
            </Button>
            <Button variant="ghost" onClick={() => changeSeason(null)} disabled={selected === null}>
              当季
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label="下一季度"
              disabled={!season || !current || season >= current}
              onClick={() => season && changeSeason(shiftSeason(season, 1))}
            >
              <ChevronRight size={18} />
            </Button>
          </>
        }
      />
      {query.isError && (
        <div className="calendar-message" role="alert">
          <p>{query.error.message}</p>
          <Button variant="secondary" onClick={() => query.refetch()}>
            重新读取
          </Button>
        </div>
      )}
      {data && (
        <>
          <Tabs.Root value={dayValue} onValueChange={changeDay} className="calendar-tabs">
            <CalendarWeekTabs items={data.items} dayValue={dayValue} onDayChange={changeDay} busy={entryBusy} />
            <div ref={panelsRef} className="calendar-panels" style={{ minHeight: panelMinHeight }}>
              <Tabs.Content key={entryKey} value={dayValue} className="calendar-day calendar-day-panel">
                {dayItems.length ? (
                  <Masonry
                    className="calendar-items calendar-day-grid"
                    extraHeight={96}
                    onEntryAnimationChange={(animating) => {
                      // 旧日期的回调不能解除当前日期的切换锁。
                      if (activeEntryKey.current !== entryKey) return
                      if (animating) entryLockRef.current = true
                      setEntryState((previous) =>
                        previous?.key === entryKey && previous.animating === animating
                          ? previous
                          : { key: entryKey, animating },
                      )
                    }}
                  >
                    {dayItems.map((item, itemIndex) => (
                      <CalendarItemCard
                        key={`${data.season}-${item.id}`}
                        item={item}
                        priority={itemIndex === 0}
                        favoriteDisabled={isFavoriteBusy(data.season, item.id)}
                        onFavorite={(event) => toggleFavorite(data.season, item, event)}
                      />
                    ))}
                  </Masonry>
                ) : (
                  <p className="calendar-empty">暂无播出安排</p>
                )}
              </Tabs.Content>
            </div>
          </Tabs.Root>
        </>
      )}
    </ClickSpark>
  )
}
