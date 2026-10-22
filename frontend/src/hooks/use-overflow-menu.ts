import { useLayoutEffect, useRef, useState, type RefObject } from "react"

/** Measure an inert copy so hidden options can return when space grows. */
export function useOverflowMenu(container: RefObject<HTMLElement | null>, count: number) {
  const measureRef = useRef<HTMLDivElement>(null)
  const [visibleCount, setVisibleCount] = useState(count)
  useLayoutEffect(() => {
    const row = container.current
    const measure = measureRef.current
    if (!row || !measure) return
    const update = () => {
      const widths = Array.from(measure.children, (child) => child.getBoundingClientRect().width)
      const gap = parseFloat(getComputedStyle(row).columnGap) || 0
      const style = getComputedStyle(row)
      const available = row.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      const total = widths.reduce((sum, width) => sum + width, 0) + gap * (count - 1)
      if (total <= available) return setVisibleCount(count)
      let used = 112
      let shown = 0
      while (shown < count && used + gap + widths[shown] <= available) {
        used += gap + widths[shown++]
      }
      setVisibleCount(shown)
    }
    const observer = new ResizeObserver(update)
    observer.observe(row)
    for (const child of measure.children) observer.observe(child)
    update()
    return () => observer.disconnect()
  }, [container, count])
  return { measureRef, visibleCount }
}
