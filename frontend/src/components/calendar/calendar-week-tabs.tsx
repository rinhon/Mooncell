import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { Tabs } from "radix-ui"
import { motion, useReducedMotion } from "motion/react"
import { spring } from "@/lib/motion"
import { useOverflowMenu } from "@/hooks/use-overflow-menu"
import { calendarWeekdays as weekdays } from "@/components/calendar-loading"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu"
import type { CalendarItem } from "./types"

const highlightWidth = 100

export function CalendarWeekTabs({
  items,
  dayValue,
  onDayChange,
  busy = false,
}: {
  items: CalendarItem[]
  dayValue: string
  onDayChange: (value: string) => void
  busy?: boolean
}) {
  const reducedMotion = useReducedMotion()
  const listRef = useRef<HTMLDivElement>(null)
  const { measureRef, visibleCount } = useOverflowMenu(listRef, weekdays.length)
  const [indicator, setIndicator] = useState({ left: 0, width: 0, ready: false })
  const measureIndicator = useCallback(() => {
    const tab = listRef.current?.querySelector<HTMLButtonElement>(
      '[role="tab"][data-state="active"]:not([hidden]), .overflow-trigger[data-active="true"]',
    )
    const label = tab?.querySelector<HTMLElement>(".calendar-week-label")
    // 使用 tab 行内部坐标，让高亮与页面、内容面板的 motion 边界保持独立。
    if (tab?.offsetWidth && label) {
      setIndicator({ left: tab.offsetLeft + label.offsetLeft, width: label.offsetWidth, ready: true })
    } else setIndicator((previous) => ({ ...previous, ready: false }))
  }, [])
  useLayoutEffect(() => {
    measureIndicator()
  }, [dayValue, visibleCount, measureIndicator])
  const hoveredTab = useRef<HTMLButtonElement | null>(null)
  const [hover, setHover] = useState({ left: 0, width: 0, visible: false })
  const moveHover = useCallback((tab: HTMLButtonElement) => {
    if (!listRef.current?.contains(tab) || tab.hidden || !tab.offsetWidth) {
      hoveredTab.current = null
      setHover((previous) => ({ ...previous, visible: false }))
      return
    }
    hoveredTab.current = tab
    // 背景只包住内容，避免宽屏等分点击区撑大 hover；实际宽度也不会拉伸圆角。
    const label = tab.querySelector<HTMLElement>(".calendar-week-label")
    const count = tab.querySelector<HTMLElement>(".calendar-week-count")
    const contentEnd = count ?? label
    const left = Math.max(0, (label?.offsetLeft ?? 0) - 16)
    const right = Math.min(
      tab.offsetWidth,
      contentEnd ? contentEnd.offsetLeft + contentEnd.offsetWidth + 16 : tab.offsetWidth,
    )
    setHover({ left: tab.offsetLeft + left, width: right - left, visible: true })
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
    for (const tab of list.querySelectorAll<HTMLButtonElement>("button")) observer.observe(tab)
    return () => observer.disconnect()
  }, [moveHover, measureIndicator, visibleCount])
  return (
    <Tabs.List
      ref={listRef}
      className="calendar-week-tabs"
      aria-label="选择播出星期"
      aria-busy={busy || undefined}
      onPointerLeave={hideHover}
      onPointerCancel={hideHover}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) hideHover()
      }}
    >
      {indicator.width > 0 && (
        <motion.span
          initial={false}
          aria-hidden="true"
          className="calendar-week-indicator"
          animate={{ x: indicator.left, scaleX: indicator.width / highlightWidth }}
          transition={reducedMotion ? { duration: 0 } : spring.snappy}
          style={{ width: highlightWidth, transformOrigin: "left", visibility: indicator.ready ? "visible" : "hidden" }}
        />
      )}
      {hover.width > 0 && (
        <motion.span
          initial={false}
          aria-hidden="true"
          className="calendar-week-hover"
          animate={{ x: hover.left, opacity: hover.visible ? 1 : 0 }}
          transition={reducedMotion ? { duration: 0 } : spring.snappy}
          style={{ width: hover.width }}
        />
      )}
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
          // Radix 不会上报当前标签；同帧切走再点回时仍需保存这次输入。
          onClick={() => onDayChange(String(index))}
          onPointerEnter={(event) => {
            if (event.pointerType === "mouse") moveHover(event.currentTarget)
          }}
          onFocus={(event) => moveHover(event.currentTarget)}
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
              data-active={Number(dayValue) >= visibleCount}
              aria-label="更多星期"
              onPointerEnter={(event) => {
                if (event.pointerType === "mouse") moveHover(event.currentTarget)
              }}
              onFocus={(event) => moveHover(event.currentTarget)}
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
