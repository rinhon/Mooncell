// Adapted from React Bits Accordion Gallery by David Haz.
// See accordion-gallery.LICENSE for the upstream license.
import { useCallback, useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { gsap } from "gsap"
import { useReducedMotion } from "motion/react"
import { ShowCover } from "@/components/show-cover"
import { FadeInImage } from "@/components/ui/fade-in-image"
import "./accordion-gallery.css"

export interface AccordionGalleryItem {
  id: number
  image?: string
  label: string
  link: string
  caption?: ReactNode
  footer?: ReactNode
}

interface AccordionGalleryProps {
  items: AccordionGalleryItem[]
  activeIndex: number
  onActiveChange: (index: number) => void
  orientation?: "horizontal" | "vertical"
  height?: number
  expandRatio?: number
  gap?: number
  radius?: number
  duration?: number
  parallax?: number
  tilt?: number
}

export function AccordionGallery({ items, activeIndex, onActiveChange, orientation = "horizontal", height = 460, expandRatio = .56, gap = 10, radius, duration = .6, parallax = .5, tilt = 8 }: AccordionGalleryProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRefs = useRef<(HTMLDivElement | null)[]>([])
  const linkRefs = useRef<(HTMLAnchorElement | null)[]>([])
  const mediaRefs = useRef<(HTMLSpanElement | null)[]>([])
  const barRefs = useRef<(HTMLSpanElement | null)[]>([])
  const textRefs = useRef<(HTMLSpanElement | null)[]>([])
  const timelineRef = useRef<gsap.core.Timeline | null>(null)
  const firstRunRef = useRef(true)
  const mediaSizeRef = useRef(320)
  const reducedMotion = useReducedMotion()
  const vertical = orientation === "vertical"
  const count = items.length
  const itemKey = items.map(item => item.id).join(",")
  const active = Math.min(Math.max(activeIndex, 0), Math.max(0, count - 1))

  const applyLayout = useCallback((animate: boolean) => {
    const ratio = Math.min(Math.max(expandRatio, .2), .9)
    const grow = count > 1 ? ratio * (count - 1) / (1 - ratio) : 1
    const time = animate && !reducedMotion ? duration : 0
    timelineRef.current?.kill()
    const timeline = gsap.timeline()
    panelRefs.current.slice(0, count).forEach((panel, index) => {
      if (!panel) return
      const selected = index === active
      const rotation = selected || reducedMotion ? 0 : index < active ? tilt : -tilt
      timeline.to(panel, {
        flexGrow: selected ? grow : 1,
        rotateX: vertical ? -rotation : 0,
        rotateY: vertical ? 0 : rotation,
        duration: time,
        ease: "power3.out",
      }, 0)
      const media = mediaRefs.current[index]
      if (media) {
        const drift = Math.max(-1.5, Math.min(1.5, active - index))
        const shift = selected || reducedMotion ? 0 : drift * parallax * mediaSizeRef.current * .06
        timeline.to(media, {
          xPercent: -50, yPercent: -50,
          x: vertical ? 0 : shift, y: vertical ? shift : 0,
          duration: time, ease: "power3.out",
        }, 0)
      }
      const bar = barRefs.current[index]
      const text = textRefs.current[index]
      if (bar && text) timeline.to([bar, text], {
        opacity: selected ? 1 : 0,
        x: selected ? 0 : -14,
        duration: selected ? time : time * .6,
        ease: "power3.out",
        stagger: selected && time > 0 ? .06 : 0,
      }, 0)
    })
    timelineRef.current = timeline
  }, [active, count, expandRatio, duration, vertical, tilt, parallax, reducedMotion])

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const measure = (animate: boolean) => {
      const rect = root.getBoundingClientRect()
      const total = vertical ? rect.height : rect.width
      const usable = Math.max(total - gap * Math.max(0, count - 1), 120)
      const ratio = count === 1 ? 1 : Math.min(Math.max(expandRatio, .2), .9)
      mediaSizeRef.current = Math.max(140, usable * ratio * 1.22)
      root.style.setProperty("--ag-media-size", `${mediaSizeRef.current}px`)
      applyLayout(animate)
    }
    measure(!firstRunRef.current)
    firstRunRef.current = false
    // Ignore the observer's initial delivery so it cannot interrupt a selection animation.
    let previousSize = vertical ? root.clientHeight : root.clientWidth
    const observer = new ResizeObserver(() => {
      const size = vertical ? root.clientHeight : root.clientWidth
      if (size !== previousSize) { previousSize = size; measure(false) }
    })
    observer.observe(root)
    return () => { observer.disconnect(); timelineRef.current?.kill() }
  }, [applyLayout, count, expandRatio, gap, vertical, itemKey])

  const handleKeyDown = (index: number, event: KeyboardEvent<HTMLAnchorElement>) => {
    const forward = vertical ? "ArrowDown" : "ArrowRight"
    const back = vertical ? "ArrowUp" : "ArrowLeft"
    const next = event.key === forward ? (index + 1) % count : event.key === back ? (index - 1 + count) % count : event.key === "Home" ? 0 : event.key === "End" ? count - 1 : null
    if (next === null) return
    event.preventDefault()
    onActiveChange(next)
    linkRefs.current[next]?.focus()
  }

  return <div ref={rootRef} className={`accordion-gallery${vertical ? " accordion-gallery--vertical" : ""}`} role="list" aria-label="随机番剧推荐" style={{
    "--ag-gap": `${gap}px`, "--ag-radius": radius === undefined ? "var(--radius-panel)" : `${radius}px`,
    height: `${height}px`,
  } as CSSProperties}>
    {items.map((item, index) => {
      const selected = index === active
      return <div key={item.id} ref={node => { panelRefs.current[index] = node }} className={`ag-panel${selected ? " ag-panel--active" : ""}`} role="listitem">
        <Link ref={node => { linkRefs.current[index] = node }} className="ag-panel__link" to={item.link}
          aria-label={`${item.label}，查看详情`} aria-current={selected ? "true" : undefined}
          onPointerEnter={event => { if (!vertical && event.pointerType === "mouse") onActiveChange(index) }}
          onFocus={event => { if (event.currentTarget.matches(":focus-visible")) onActiveChange(index) }}
          onKeyDown={event => handleKeyDown(index, event)}
          onClick={event => { if (!selected) { event.preventDefault(); onActiveChange(index) } }}>
          <span className="ag-panel__frame">
            <span className="ag-panel__media" ref={node => { mediaRefs.current[index] = node }}>
              {item.image ? <>
                <FadeInImage src={item.image} alt="" draggable={false}/>
                <img src={item.image} alt="" aria-hidden="true" draggable={false} className="ag-panel__media-blur"/>
              </> : <ShowCover title={item.label}/>}
            </span>
            <span className="ag-panel__scrim" aria-hidden="true"/>
          </span>
          <span className="ag-panel__label" aria-hidden="true">
            <span className="ag-panel__bar" ref={node => { barRefs.current[index] = node }}/>
            <span className="ag-panel__text" ref={node => { textRefs.current[index] = node }}>
              <strong>{item.label}</strong>
              {item.caption}
              <span className="ag-panel__action">查看详情 <span>↗</span></span>
            </span>
          </span>
        </Link>
        {selected && item.footer}
      </div>
    })}
  </div>
}
