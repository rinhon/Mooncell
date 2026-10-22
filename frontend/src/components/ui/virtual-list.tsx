import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { cn } from "@/lib/utils"

type VirtualListProps<T> = {
  items: readonly T[]
  itemKey: (item: T) => string | number
  renderItem: (item: T, index: number) => ReactNode
  label: string
  estimatedItemHeight?: number
  overscan?: number
  className?: string
}

/** Measured rows support wrapped content while keeping large lists inexpensive to render. */
export function VirtualList<T>({
  items,
  itemKey,
  renderItem,
  label,
  estimatedItemHeight = 180,
  overscan = 3,
  className,
}: VirtualListProps<T>) {
  const viewport = useRef<HTMLDivElement>(null)
  const heights = useRef(new Map<string | number, number>())
  const [revision, setRevision] = useState(0)
  const [view, setView] = useState({ top: 0, height: 640 })
  const keys = useMemo(() => items.map(itemKey), [items, itemKey])
  const offsets = useMemo(() => {
    const result = [0]
    for (const item of items)
      result.push(result[result.length - 1] + (heights.current.get(itemKey(item)) ?? estimatedItemHeight))
    return result
  }, [items, itemKey, estimatedItemHeight, revision])
  const totalHeight = offsets[offsets.length - 1]
  const top = Math.min(view.top, Math.max(0, totalHeight - view.height))
  // Find the row at the viewport edge without walking through the entire list on scroll.
  function indexAt(position: number) {
    let low = 0
    let high = items.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (offsets[middle + 1] <= position) low = middle + 1
      else high = middle
    }
    return low
  }
  const start = Math.max(0, indexAt(top) - overscan)
  const end = Math.min(items.length, indexAt(top + view.height) + overscan + 1)
  const measure = useCallback((key: string | number, height: number) => {
    if (height <= 0 || heights.current.get(key) === height) return
    heights.current.set(key, height)
    setRevision((value) => value + 1)
  }, [])

  useLayoutEffect(() => {
    const element = viewport.current
    if (!element) return
    let width = element.clientWidth
    const update = () => {
      if (width !== element.clientWidth) {
        width = element.clientWidth
        heights.current.clear()
        setRevision((value) => value + 1)
      }
      setView({ top: element.scrollTop, height: element.clientHeight })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const activeKeys = new Set(items.map(itemKey))
    for (const key of heights.current.keys()) if (!activeKeys.has(key)) heights.current.delete(key)
    const element = viewport.current
    if (element && element.scrollTop > Math.max(0, totalHeight - element.clientHeight)) {
      element.scrollTop = Math.max(0, totalHeight - element.clientHeight)
    }
  }, [items, itemKey, totalHeight])

  return (
    <div
      ref={viewport}
      className={cn("virtual-list", className)}
      role="region"
      aria-label={label}
      tabIndex={0}
      onScroll={(event) => setView({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}
    >
      <div role="list" aria-label={label} className="virtual-list-track" style={{ height: totalHeight }}>
        {items.slice(start, end).map((item, localIndex) => {
          const index = start + localIndex
          return (
            <MeasuredRow
              key={keys[index]}
              rowKey={keys[index]}
              index={index}
              count={items.length}
              top={offsets[index]}
              measure={measure}
            >
              {renderItem(item, index)}
            </MeasuredRow>
          )
        })}
      </div>
    </div>
  )
}

function MeasuredRow({
  rowKey,
  index,
  count,
  top,
  measure,
  children,
}: {
  rowKey: string | number
  index: number
  count: number
  top: number
  measure: (key: string | number, height: number) => void
  children: ReactNode
}) {
  const row = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (row.current) measure(rowKey, row.current.getBoundingClientRect().height)
  })
  useLayoutEffect(() => {
    const element = row.current
    if (!element) return
    const update = () => measure(rowKey, element.getBoundingClientRect().height)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [rowKey, measure])
  return (
    <div
      ref={row}
      role="listitem"
      aria-posinset={index + 1}
      aria-setsize={count}
      className="virtual-list-row"
      style={{ transform: `translateY(${top}px)` }}
    >
      {children}
    </div>
  )
}
