import { useContext, useLayoutEffect, useRef, type ReactNode } from "react"
import { PageMotionContext } from "@/lib/page-motion"
import "./fade-slide.css"

/** 仅对匹配的内容执行一次淡入上移，不改变布局或添加指针交互。 */
export function FadeSlide({
  children,
  className,
  selector,
}: {
  children: ReactNode
  className?: string
  selector: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { animateCards } = useContext(PageMotionContext)

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container || !animateCards) return

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")
    const elements = new Set<HTMLElement>()
    const pending = new Set<HTMLElement>()
    const animations = new Map<HTMLElement, Animation>()
    const show = (element: HTMLElement) => {
      pending.delete(element)
      observer.unobserve(element)
      const animation = animations.get(element)
      if (animation) {
        animation.onfinish = null
        animation.cancel()
        animations.delete(element)
      }
      element.removeAttribute("data-fade-slide")
    }
    const reveal = (element: HTMLElement, delay: number) => {
      if (!pending.has(element)) return
      if (reducedMotion.matches) {
        show(element)
        return
      }
      pending.delete(element)
      observer.unobserve(element)
      const animation = element.animate(
        [
          { opacity: 0, transform: "translateY(16px)" },
          { opacity: 1, transform: "translateY(0)" },
        ],
        { duration: 560, delay, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", fill: "both" },
      )
      animations.set(element, animation)
      element.setAttribute("data-fade-slide", "running")
      animation.onfinish = () => show(element)
    }
    const observer = new IntersectionObserver(
      (entries) => {
        entries
          .filter((entry) => entry.isIntersecting && pending.has(entry.target as HTMLElement))
          .sort((a, b) => (a.target.compareDocumentPosition(b.target) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
          .forEach((entry, index) => reveal(entry.target as HTMLElement, Math.min(index, 6) * 65))
      },
      { threshold: 0.08 },
    )
    const syncElements = () => {
      const current = new Set(container.querySelectorAll<HTMLElement>(selector))
      elements.forEach((element) => {
        if (!current.has(element)) {
          show(element)
          elements.delete(element)
        }
      })
      current.forEach((element) => {
        if (elements.has(element)) return
        elements.add(element)
        if (reducedMotion.matches) return
        element.setAttribute("data-fade-slide", "pending")
        pending.add(element)
        observer.observe(element)
      })
    }
    const containsElement = (node: Node) =>
      node instanceof Element && (node.matches(selector) || node.querySelector(selector) !== null)
    const mutationObserver = new MutationObserver((records) => {
      if (records.some((record) => [...record.addedNodes, ...record.removedNodes].some(containsElement))) syncElements()
    })
    const focus = (event: FocusEvent) => {
      const element = event.target instanceof Element ? event.target.closest<HTMLElement>(selector) : null
      if (element && elements.has(element)) show(element)
    }
    const syncPreference = () => {
      if (reducedMotion.matches) elements.forEach(show)
    }

    syncElements()
    mutationObserver.observe(container, { childList: true, subtree: true })
    container.addEventListener("focusin", focus)
    reducedMotion.addEventListener("change", syncPreference)

    return () => {
      mutationObserver.disconnect()
      observer.disconnect()
      container.removeEventListener("focusin", focus)
      reducedMotion.removeEventListener("change", syncPreference)
      elements.forEach(show)
    }
  }, [animateCards, selector])

  return (
    <div ref={containerRef} className={className}>
      {children}
    </div>
  )
}
