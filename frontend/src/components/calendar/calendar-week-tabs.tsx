import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { Tabs } from "radix-ui"
import { motion, useReducedMotion } from "motion/react"
import { spring } from "@/lib/motion"
import { useOverflowMenu } from "@/hooks/use-overflow-menu"
import { calendarWeekdays as weekdays } from "@/components/calendar-loading"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu"
import type { CalendarItem } from "./types"

export function CalendarWeekTabs({
  items,
  dayValue,
  onDayChange,
}: {
  items: CalendarItem[]
  dayValue: string
  onDayChange: (value: string) => void
}) {
  const reducedMotion = useReducedMotion()
  const highlightWidth = 100
  const listRef = useRef<HTMLDivElement>(null)
  const { measureRef, visibleCount } = useOverflowMenu(listRef, weekdays.length)
  const [indicator, setIndicator] = useState({ left: 0, width: 0, ready: false })
  const measureIndicator = useCallback(() => {
    const tab = listRef.current?.querySelector<HTMLButtonElement>('[role="tab"][data-state="active"]:not([hidden])')
    if (tab) setIndicator({ left: tab.offsetLeft, width: tab.offsetWidth, ready: true })
    else setIndicator((previous) => ({ ...previous, ready: false }))
  }, [])
  useLayoutEffect(() => {
    measureIndicator()
  }, [dayValue, visibleCount, measureIndicator])
  const hoveredTab = useRef<HTMLButtonElement | null>(null)
  const [hover, setHover] = useState({ left: 0, width: 0, visible: false })
  const moveHover = useCallback((tab: HTMLButtonElement) => {
    hoveredTab.current = tab
    setHover({ left: tab.offsetLeft, width: tab.offsetWidth, visible: true })
  }, [])
  function hideHover() {
    hoveredTab.current = null
    setHover((previous) => ({ ...previous, visible: false }))
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
  return (
    <Tabs.List
      ref={listRef}
      className="calendar-week-tabs calendar-week-tabs-indicated"
      aria-label="选择播出星期"
      onPointerLeave={hideHover}
      onPointerCancel={hideHover}
    >
      <motion.span
        initial={false}
        aria-hidden="true"
        className="calendar-week-indicator"
        animate={{ x: indicator.left, scaleX: indicator.width / highlightWidth }}
        transition={reducedMotion ? { duration: 0 } : spring.snappy}
        style={{ width: highlightWidth, transformOrigin: "left", visibility: indicator.ready ? "visible" : "hidden" }}
      />
      <motion.span
        initial={false}
        aria-hidden="true"
        className="calendar-week-hover"
        data-visible={hover.visible}
        animate={{ x: hover.left, scaleX: hover.width / highlightWidth }}
        transition={reducedMotion ? { duration: 0 } : spring.snappy}
        style={{ width: highlightWidth, transformOrigin: "left" }}
      />
      <div ref={measureRef} className="overflow-measure" aria-hidden="true" inert>
        {weekdays.map((day, index) => (
          <span className="calendar-week-tab" key={day}>
            <span className="calendar-week-label">{day}</span>
            <span className="calendar-week-count">
              {items.filter((item) => (index === 7 ? item.weekday === null : item.weekday === index)).length}
            </span>
          </span>
        ))}
      </div>
      {weekdays.map((day, index) => (
        <Tabs.Trigger
          key={day}
          value={String(index)}
          hidden={index >= visibleCount}
          className="calendar-week-tab"
          onPointerEnter={(event) => {
            if (event.pointerType === "mouse") moveHover(event.currentTarget)
          }}
        >
          <span className="calendar-week-label">{day}</span>
          <span className="calendar-week-count">
            {items.filter((item) => (index === 7 ? item.weekday === null : item.weekday === index)).length}
          </span>
        </Tabs.Trigger>
      ))}
      {visibleCount < weekdays.length && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="calendar-week-tab overflow-trigger"
              data-state={Number(dayValue) >= visibleCount ? "active" : "inactive"}
              aria-label="更多星期"
              onPointerEnter={hideHover}
            >
              <span className="calendar-week-label">
                {Number(dayValue) >= visibleCount ? weekdays[Number(dayValue)] : "更多"}
              </span>
              <span className="calendar-week-count" aria-hidden="true">
                ▾
              </span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {weekdays.slice(visibleCount).map((day, offset) => {
              const index = visibleCount + offset
              return (
                <DropdownMenuItem key={day} onSelect={() => onDayChange(String(index))}>
                  <span className="calendar-week-label">{day}</span>
                  <span className="calendar-week-count">
                    {items.filter((item) => (index === 7 ? item.weekday === null : item.weekday === index)).length}
                  </span>
                  {dayValue === String(index) && <span aria-hidden="true">✓</span>}
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </Tabs.List>
  )
}
