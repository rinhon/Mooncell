import { Tabs } from "radix-ui"
import { forwardRef, useEffect, useRef, useState, type ReactNode } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useSearchParams } from "react-router-dom"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import ClickSpark from "@/components/click-spark"
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react"
import { CalendarHeader, CalendarLoading, calendarWeekdays as weekdays } from "@/components/calendar-loading"
import { CalendarItemCard } from "@/components/calendar/calendar-item-card"
import { CalendarWeekTabs } from "@/components/calendar/calendar-week-tabs"
import { useCalendarFavorite } from "@/components/calendar/use-calendar-favorite"
import type { CalendarItem, SeasonCalendar } from "@/components/calendar/types"
import { api } from "@/lib/api"
import { spring } from "@/lib/motion"
import { useTheme } from "@/lib/theme"

function shiftSeason(season: string, offset: number) {
  const date = new Date(Number(season.slice(0, 4)), Number(season.slice(4)) - 1 + offset * 3, 1)
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}`
}
const dayVariants = {
  enter: (direction: number) => ({ x: `${direction * 100}%`, opacity: direction ? 0.4 : 1 }),
  active: { x: "0%", opacity: 1 },
  exit: (direction: number) => ({ x: `${direction * -100}%`, opacity: direction ? 0.4 : 1 }),
}
const CalendarDayPanel = forwardRef<HTMLDivElement, { value: string; direction: number; children: ReactNode }>(
  function CalendarDayPanel({ value, direction, children }, ref) {
    const present = useIsPresent()
    const reducedMotion = useReducedMotion()
    return (
      <Tabs.Content value={value} forceMount asChild ref={ref}>
        <motion.div
          className="calendar-day calendar-day-panel"
          custom={direction}
          variants={dayVariants}
          initial="enter"
          animate="active"
          exit="exit"
          transition={reducedMotion ? { duration: 0 } : spring.snappy}
          inert={!present || undefined}
          aria-hidden={!present || undefined}
          style={{ pointerEvents: present ? undefined : "none" }}
        >
          {children}
        </motion.div>
      </Tabs.Content>
    )
  },
)

export function CalendarPage() {
  const { palette } = useTheme()
  const reducedMotion = useReducedMotion()
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
  const season = selected ?? data?.season
  const current =
    data?.current_season ?? queryClient.getQueryData<SeasonCalendar>(["season-calendar", null])?.current_season
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
              onClick={() => season && setSelected(shiftSeason(season, -1))}
            >
              <ChevronLeft size={18} />
            </Button>
            <Button variant="ghost" onClick={() => setSelected(null)} disabled={selected === null}>
              当季
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label="下一季度"
              disabled={!season || !current || season >= current}
              onClick={() => season && setSelected(shiftSeason(season, 1))}
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
            <CalendarWeekTabs items={data.items} dayValue={dayValue} onDayChange={changeDay} />
            <div ref={panelsRef} className="calendar-panels" style={{ minHeight: panelMinHeight }}>
              <AnimatePresence mode="popLayout" custom={reducedMotion ? 0 : dayDirection}>
                {weekdays.map((day, index) => {
                  if (dayValue !== String(index)) return null
                  const sortLiked = (item: CalendarItem) => favoriteOrder[`${data.season}-${item.id}`] ?? item.liked
                  const items = data.items
                    .filter((item) => (index === 7 ? item.weekday === null : item.weekday === index))
                    .sort((a, b) => Number(Boolean(sortLiked(b))) - Number(Boolean(sortLiked(a))))
                  return (
                    <CalendarDayPanel
                      value={String(index)}
                      direction={reducedMotion ? 0 : dayDirection}
                      key={`${data.season}-${day}`}
                    >
                      <div className="calendar-items calendar-day-grid">
                        {items.length ? (
                          items.map((item, itemIndex) => (
                            <CalendarItemCard
                              key={`${data.season}-${item.id}`}
                              item={item}
                              priority={itemIndex === 0}
                              favoriteDisabled={isFavoriteBusy(data.season, item.id)}
                              onFavorite={(event) => toggleFavorite(data.season, item, event)}
                            />
                          ))
                        ) : (
                          <p className="calendar-empty">暂无播出安排</p>
                        )}
                      </div>
                    </CalendarDayPanel>
                  )
                })}
              </AnimatePresence>
            </div>
          </Tabs.Root>
        </>
      )}
    </ClickSpark>
  )
}
