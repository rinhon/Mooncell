import { spring } from "@/lib/motion"
import { useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { motion, useReducedMotion } from "motion/react"

export function ShowDetailPanels({ activeKey, children }: { activeKey: string; children: ReactNode }) {
  const container = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const previousKey = useRef(activeKey)
  const viewportFloor = useRef(0)
  const [height, setHeight] = useState<number | null>(null)
  const reducedMotion = useReducedMotion()

  useLayoutEffect(() => {
    const element = content.current
    const outer = container.current
    if (!element || !outer) return
    if (previousKey.current !== activeKey) {
      // 短面板仍填满当前视口，避免文档缩短后浏览器强制夹紧滚动位置。
      viewportFloor.current = Math.max(0, window.innerHeight - outer.getBoundingClientRect().top)
      previousKey.current = activeKey
    }
    const measure = () => setHeight(Math.max(viewportFloor.current, element.offsetHeight))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [activeKey])

  useLayoutEffect(() => {
    const outer = container.current
    if (!outer) return
    let frame: number | null = null
    const resolveTabs = () => {
      const candidate = outer.previousElementSibling
      return candidate instanceof HTMLElement && candidate.matches(".detail-tabs") ? candidate : null
    }
    const updateClip = () => {
      frame = null
      const tabs = resolveTabs()
      if (!tabs) return
      const tabsRect = tabs.getBoundingClientRect()
      const outerRect = outer.getBoundingClientRect()
      // 透明页签下沿作为裁剪边界，吸顶时不让集数内容透到页签文字后方。
      const clipTop = Math.max(0, tabsRect.bottom - outerRect.top)
      outer.style.setProperty("--detail-panels-clip-top", `${clipTop}px`)
    }
    const scheduleClip = () => {
      if (frame === null) frame = window.requestAnimationFrame(updateClip)
    }
    const tabs = resolveTabs()
    const observer = new ResizeObserver(scheduleClip)
    for (const element of [
      outer,
      tabs,
      outer.parentElement,
      outer.closest(".detail-grid"),
      tabs?.previousElementSibling,
    ]) {
      if (element) observer.observe(element)
    }
    window.addEventListener("scroll", updateClip, { passive: true })
    window.addEventListener("resize", updateClip)
    updateClip()
    return () => {
      observer.disconnect()
      window.removeEventListener("scroll", updateClip)
      window.removeEventListener("resize", updateClip)
      if (frame !== null) window.cancelAnimationFrame(frame)
      outer.style.removeProperty("--detail-panels-clip-top")
    }
  }, [activeKey])

  return (
    <motion.div
      ref={container}
      className="detail-panels"
      initial={false}
      animate={{ height: height ?? "auto" }}
      transition={reducedMotion ? { duration: 0 } : spring.layout}
    >
      <div ref={content}>{children}</div>
    </motion.div>
  )
}
