import { useId, useLayoutEffect, useRef, useState } from "react"
import { ChevronDown } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"

export function ShowOverview({ overview }: { overview?: string | null }) {
  const contentId = useId()
  const fullRef = useRef<HTMLParagraphElement>(null)
  const previewRef = useRef<HTMLParagraphElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [hasToggled, setHasToggled] = useState(false)
  const [size, setSize] = useState({ full: 0, collapsed: 0 })
  const reducedMotion = useReducedMotion()
  const canExpand = size.full > size.collapsed + 1
  const isExpanded = expanded && canExpand
  const text = overview || "暂无剧情简介"
  const duration = reducedMotion || !hasToggled ? 0 : isExpanded ? .34 : .28

  useLayoutEffect(() => {
    const full = fullRef.current
    const preview = previewRef.current
    if (!full || !preview) return
    const measure = () => {
      const next = { full: full.getBoundingClientRect().height, collapsed: preview.getBoundingClientRect().height }
      setSize(previous => previous.full === next.full && previous.collapsed === next.collapsed ? previous : next)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(full)
    observer.observe(preview)
    measure()
    return () => observer.disconnect()
  }, [text])

  return <section className="detail-overview">
    <h2>剧情简介</h2>
    <motion.div
      id={contentId}
      className="detail-overview-content"
      initial={false}
      animate={{ height: size.full ? isExpanded ? size.full : size.collapsed : "auto" }}
      transition={{ duration, ease: [.22, 1, .36, 1] }}
    >
      <motion.p ref={fullRef} initial={false} animate={{ opacity: canExpand && !isExpanded ? 0 : 1 }} transition={{ duration: Math.min(duration, .16) }}>{text}</motion.p>
      <motion.p ref={previewRef} className="detail-overview-preview is-collapsed" aria-hidden="true" initial={false} animate={{ opacity: canExpand && !isExpanded ? 1 : 0 }} transition={{ duration: Math.min(duration, .16) }}>{text}</motion.p>
    </motion.div>
    {canExpand && <motion.button
      type="button"
      className="detail-overview-toggle"
      aria-expanded={isExpanded}
      aria-controls={contentId}
      whileTap={reducedMotion ? undefined : { scale: .97 }}
      onClick={() => { setHasToggled(true); setExpanded(value => !value) }}
    >
      <span>{isExpanded ? "收起" : "展开全部"}</span>
      <motion.span aria-hidden="true" initial={false} animate={{ rotate: isExpanded ? 180 : 0 }} transition={{ duration: reducedMotion ? 0 : .24, ease: [.22, 1, .36, 1] }}><ChevronDown size={14}/></motion.span>
    </motion.button>}
  </section>
}
