import { useLayoutEffect, useRef, useState } from "react"
import { motion, useReducedMotion } from "motion/react"

type TabItem = { key: string; label: string; count?: number }

export function ShowDetailTabs({ items, activeKey, onSelect }: {
  items: TabItem[]; activeKey: string; onSelect: (key: string) => void
}) {
  const row = useRef<HTMLDivElement>(null)
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const [bounds, setBounds] = useState<{ x: number; width: number } | null>(null)
  const reducedMotion = useReducedMotion()
  const itemKeys = items.map(item => item.key).join(",")

  useLayoutEffect(() => {
    const element = row.current
    if (!element) return
    const measure = () => {
      const button = element.querySelector<HTMLButtonElement>('[aria-selected="true"]')
      if (button) setBounds({ x: button.offsetLeft, width: button.offsetWidth })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    buttons.current.forEach(button => { if (button) observer.observe(button) })
    return () => observer.disconnect()
  }, [activeKey, itemKeys])

  return <div className="detail-tabs">
    <div ref={row} className="detail-tabs-track" role="tablist" aria-label="季度与订阅信息">
      {items.map((item, index) => <button key={item.key} type="button" ref={element => { buttons.current[index] = element }} role="tab" id={`detail-tab-${item.key}`} aria-controls={`detail-panel-${item.key}`} aria-selected={activeKey === item.key} tabIndex={activeKey === item.key ? 0 : -1} onClick={() => onSelect(item.key)} onKeyDown={event => {
        if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return
        event.preventDefault()
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length
        onSelect(items[next].key)
        buttons.current[next]?.focus({ preventScroll: true })
        const button = buttons.current[next]
        const container = row.current
        if (button && container) {
          const left = button.offsetLeft
          if (left < container.scrollLeft) container.scrollTo({ left, behavior: reducedMotion ? "instant" : "smooth" })
          else if (left + button.offsetWidth > container.scrollLeft + container.clientWidth) container.scrollTo({ left: left + button.offsetWidth - container.clientWidth, behavior: reducedMotion ? "instant" : "smooth" })
        }
      }}>{item.label}{item.count != null && <span>{item.count}</span>}</button>)}
      {bounds && <motion.span className="detail-tab-indicator" aria-hidden="true" initial={false} style={{ width: 100, transformOrigin: "left" }} animate={{ x: bounds.x, scaleX: bounds.width / 100 }} transition={reducedMotion ? { duration: 0 } : { type: "spring", stiffness: 400, damping: 32 }}/>}
    </div>
  </div>
}
