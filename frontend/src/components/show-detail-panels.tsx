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
      const stickyTop = parseFloat(window.getComputedStyle(tabs).top) || 0
      // .detail-tabs 自身与 ::before 在纯 CSS 下常驻不透明底色，由 GPU 合成器线程零延迟遮挡底边；
      // 裁剪线落在不透明 Tab 内部中线，配合 data-stuck 向上封顶至视口顶端。
      // 仅在实际吸顶时扩展遮罩；相邻元素的亚像素边界误差不代表已吸顶。
      tabs.toggleAttribute("data-stuck", tabsRect.top <= stickyTop + 1)
      const clipLine = tabsRect.top + tabsRect.height * 0.45
      const clipTop = Math.max(0, clipLine - outerRect.top)
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
      resolveTabs()?.removeAttribute("data-stuck")
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
