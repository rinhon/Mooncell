// Adapted from React Bits' BranchedMenu (David Haz).
// https://reactbits.dev/micro/branched-menu — see branched-menu.LICENSE.
// Variable-height branches support lazy, recursively nested filesystem menus.
import { useLayoutEffect, useRef, useState, type ReactNode } from "react"
import "./branched-menu.css"

type BranchedMenuProps<T> = {
  items: T[]
  getKey: (item: T) => string
  isActive: (item: T) => boolean
  renderItem: (item: T) => ReactNode
  label?: string
}

export function BranchedMenu<T>({ items, getKey, isActive, renderItem, label }: BranchedMenuProps<T>) {
  const listRef = useRef<HTMLUListElement>(null)
  const [rows, setRows] = useState<number[]>([])

  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const measure = () => {
      const next = Array.from(list.children, (node) => (node as HTMLElement).offsetTop + 20)
      setRows((previous) =>
        previous.length === next.length && previous.every((y, i) => y === next[i]) ? previous : next,
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    Array.from(list.children).forEach((node) => observer.observe(node))
    return () => observer.disconnect()
  }, [items])

  const trunk = 10
  const radius = 10
  const endX = 30
  const branch = (y: number) => `M ${trunk} ${y - radius} A ${radius} ${radius} 0 0 0 ${trunk + radius} ${y} H ${endX}`
  const reach = (y: number) =>
    `M ${trunk} 0 V ${y - radius} A ${radius} ${radius} 0 0 0 ${trunk + radius} ${y} H ${endX}`

  return (
    <div className="branched-menu">
      <svg className="branched-menu-lines" width="32" height={Math.max(0, rows.at(-1) ?? 0)} aria-hidden="true">
        {rows.length > 0 && <path d={`M ${trunk} 0 V ${Math.max(0, rows[rows.length - 1] - radius)}`} />}
        {items.map(
          (item, index) =>
            rows[index] !== undefined && (
              <g key={getKey(item)}>
                <path d={branch(rows[index])} />
                <path
                  className="branched-menu-trace"
                  d={reach(rows[index])}
                  pathLength="1"
                  style={{ strokeDashoffset: isActive(item) ? 0 : 1 }}
                />
              </g>
            ),
        )}
      </svg>
      <ul ref={listRef} className="branched-menu-list" aria-label={label}>
        {items.map((item) => (
          <li className="branched-menu-item" key={getKey(item)}>
            {renderItem(item)}
          </li>
        ))}
      </ul>
    </div>
  )
}
