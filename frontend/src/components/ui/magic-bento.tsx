import { useContext, useEffect, useLayoutEffect, useRef, type ReactNode } from "react"
import { PageMotionContext } from "@/lib/page-motion"
import "./magic-bento.css"

interface MagicBentoProps {
  children: ReactNode
  className?: string
  cardSelector?: string
  /** 文字可参与入场，而不必附带卡片追光和按压效果。 */
  entrySelector?: string
  animate?: boolean
}

const defaultCardSelector = ".dashboard-stat, .dashboard-panel, .dashboard-onboarding, .dashboard-recent-shows"
const cardAttribute = "data-magic-bento-card"

/** Lightweight content-preserving adaptation of https://reactbits.dev/c/components/magic-bento. */
export function MagicBento({
  children,
  className,
  cardSelector = defaultCardSelector,
  entrySelector = cardSelector,
  animate = true,
}: MagicBentoProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { animateCards } = useContext(PageMotionContext)

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container || !animate || !animateCards) return

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")
    const cards = new Set<HTMLElement>()
    const pending = new Set<HTMLElement>()
    const animations = new Map<HTMLElement, Animation>()
    let observer: IntersectionObserver | null = null

    const showCard = (card: HTMLElement) => {
      pending.delete(card)
      observer?.unobserve(card)
      const animation = animations.get(card)
      if (animation) {
        animation.onfinish = null
        animation.cancel()
        animations.delete(card)
      }
      card.removeAttribute("data-magic-bento-enter")
    }
    const reveal = (card: HTMLElement, delay: number) => {
      if (!pending.has(card)) return
      if (reducedMotion.matches) {
        showCard(card)
        return
      }
      pending.delete(card)
      observer?.unobserve(card)
      const animation = card.animate(
        [
          { opacity: 0, transform: "translateY(16px)" },
          { opacity: 1, transform: "translateY(0)" },
        ],
        { duration: 560, delay, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", fill: "both" },
      )
      animations.set(card, animation)
      card.setAttribute("data-magic-bento-enter", "running")
      animation.onfinish = () => showCard(card)
    }
    observer = new IntersectionObserver(
      (entries) => {
        entries
          .filter((entry) => entry.isIntersecting && pending.has(entry.target as HTMLElement))
          .sort((a, b) => (a.target.compareDocumentPosition(b.target) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
          .forEach((entry, index) => reveal(entry.target as HTMLElement, Math.min(index, 6) * 65))
      },
      { threshold: 0.08 },
    )
    const syncCards = () => {
      const current = new Set(container.querySelectorAll<HTMLElement>(entrySelector))
      cards.forEach((card) => {
        if (!current.has(card)) {
          showCard(card)
          cards.delete(card)
        }
      })
      current.forEach((card) => {
        if (cards.has(card)) return
        cards.add(card)
        if (reducedMotion.matches) return
        // Register the initial viewport before paint, just like cards revealed after scrolling.
        card.setAttribute("data-magic-bento-enter", "pending")
        pending.add(card)
        observer?.observe(card)
      })
    }
    const containsCard = (node: Node) =>
      node instanceof Element && (node.matches(entrySelector) || node.querySelector(entrySelector) !== null)
    const mutationObserver = new MutationObserver((records) => {
      if (records.some((record) => [...record.addedNodes, ...record.removedNodes].some(containsCard))) syncCards()
    })
    const focus = (event: FocusEvent) => {
      const card = event.target instanceof Element ? event.target.closest<HTMLElement>(entrySelector) : null
      if (card && cards.has(card)) showCard(card)
    }
    const syncPreference = () => {
      if (reducedMotion.matches) cards.forEach(showCard)
    }

    syncCards()
    mutationObserver.observe(container, { childList: true, subtree: true })
    container.addEventListener("focusin", focus)
    reducedMotion.addEventListener("change", syncPreference)

    return () => {
      mutationObserver.disconnect()
      observer?.disconnect()
      container.removeEventListener("focusin", focus)
      reducedMotion.removeEventListener("change", syncPreference)
      cards.forEach(showCard)
    }
  }, [animate, animateCards, entrySelector])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)")
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")
    const cards = new Set<HTMLElement>()
    const waves = new Map<HTMLElement, number>()
    const presses = new Map<HTMLElement, { scale: number; velocity: number }>()
    let pressedCard: HTMLElement | null = null
    let pressedPointer: number | null = null
    let borderWave: { x: number; y: number; start: number; reach: number } | null = null
    let enabled = false
    let frame = 0
    let lastFrame = 0
    let pointer: { x: number; y: number } | null = null

    const clearBorderWave = (card: HTMLElement) => {
      for (const property of ["x", "y", "radius", "alpha"]) card.style.removeProperty(`--magic-bento-wave-${property}`)
    }
    const clearCard = (card: HTMLElement) => {
      card.style.removeProperty("--magic-bento-x")
      card.style.removeProperty("--magic-bento-y")
      card.style.removeProperty("--magic-bento-intensity")
      card.style.removeProperty("--magic-bento-scale")
      clearBorderWave(card)
    }
    const removeWave = (wave: HTMLElement) => {
      const timer = waves.get(wave)
      if (timer !== undefined) window.clearTimeout(timer)
      waves.delete(wave)
      wave.remove()
    }
    const reset = () => {
      if (frame) window.cancelAnimationFrame(frame)
      frame = 0
      pointer = null
      pressedCard = null
      pressedPointer = null
      borderWave = null
      presses.clear()
      cards.forEach(clearCard)
      waves.forEach((_, wave) => removeWave(wave))
    }
    const update = (now: number) => {
      frame = 0
      if (!enabled) return
      const elapsed = Math.min(0.05, (now - lastFrame) / 1000 || 1 / 60)
      lastFrame = now
      const position = pointer
      const wave = borderWave
      const progress = wave ? Math.min(1, (now - wave.start) / 1100) : 1
      let busy = Boolean(wave && progress < 1)
      if (wave && progress === 1) borderWave = null
      cards.forEach((card) => {
        const rect = card.getBoundingClientRect()
        const intensity = position
          ? Math.max(
              0,
              1 -
                Math.hypot(
                  Math.max(rect.left - position.x, 0, position.x - rect.right),
                  Math.max(rect.top - position.y, 0, position.y - rect.bottom),
                ) /
                  240,
            )
          : 0
        if (position) {
          card.style.setProperty("--magic-bento-x", `${position.x - rect.left}px`)
          card.style.setProperty("--magic-bento-y", `${position.y - rect.top}px`)
        }
        card.style.setProperty("--magic-bento-intensity", intensity.toFixed(3))
        if (wave && progress < 1) {
          card.style.setProperty("--magic-bento-wave-x", `${wave.x - rect.left}px`)
          card.style.setProperty("--magic-bento-wave-y", `${wave.y - rect.top}px`)
          card.style.setProperty("--magic-bento-wave-radius", `${wave.reach * (1 - (1 - progress) ** 2.2)}px`)
          card.style.setProperty("--magic-bento-wave-alpha", ((1 - progress) ** 1.3).toFixed(3))
        } else if (wave) clearBorderWave(card)
      })
      presses.forEach((press, card) => {
        const target = card === pressedCard ? 0.985 : 1
        const steps = Math.max(1, Math.ceil(elapsed * 240))
        const step = elapsed / steps
        for (let index = 0; index < steps; index++) {
          press.velocity += (420 * (target - press.scale) - 28 * press.velocity) * step
          press.scale += press.velocity * step
        }
        if (Math.abs(target - press.scale) < 0.0001 && Math.abs(press.velocity) < 0.001) {
          press.scale = target
          press.velocity = 0
          if (target === 1) {
            card.style.removeProperty("--magic-bento-scale")
            presses.delete(card)
            return
          }
        } else busy = true
        // 独立 scale 不会覆盖入场动画的 translateY。
        card.style.setProperty("--magic-bento-scale", press.scale.toFixed(5))
      })
      if (busy) frame = window.requestAnimationFrame(update)
    }
    const schedule = () => {
      if (enabled && !frame) {
        lastFrame = performance.now()
        frame = window.requestAnimationFrame(update)
      }
    }
    const syncCards = () => {
      const current = new Set(container.querySelectorAll<HTMLElement>(cardSelector))
      cards.forEach((card) => {
        if (!current.has(card)) {
          clearCard(card)
          presses.delete(card)
          if (pressedCard === card) {
            pressedCard = null
            pressedPointer = null
          }
          waves.forEach((_, wave) => {
            if (wave.parentElement === card) removeWave(wave)
          })
          card.removeAttribute(cardAttribute)
          cards.delete(card)
        }
      })
      current.forEach((card) => {
        card.setAttribute(cardAttribute, "")
        cards.add(card)
      })
      schedule()
    }
    const syncPreference = () => {
      enabled = finePointer.matches && !reducedMotion.matches && !document.hidden
      container.dataset.magicBentoEnabled = String(enabled)
      if (!enabled) reset()
    }
    const move = (event: PointerEvent) => {
      if (!enabled || event.pointerType !== "mouse") return
      pointer = { x: event.clientX, y: event.clientY }
      schedule()
    }
    const getCard = (target: EventTarget | null) => {
      if (!(target instanceof Element) || target.closest('[disabled], [aria-disabled="true"]')) return null
      const card = target.closest<HTMLElement>(`[${cardAttribute}]`)
      return card && cards.has(card) ? card : null
    }
    const press = (event: PointerEvent) => {
      if (!enabled || event.pointerType !== "mouse" || event.button !== 0 || !event.isPrimary) return
      const card = getCard(event.target)
      if (!card) return
      pressedCard = card
      pressedPointer = event.pointerId
      if (!presses.has(card)) presses.set(card, { scale: 1, velocity: 0 })
      pointer = { x: event.clientX, y: event.clientY }
      schedule()
    }
    const release = (event: PointerEvent) => {
      if (event.pointerId !== pressedPointer) return
      pressedCard = null
      pressedPointer = null
      schedule()
    }
    const leave = () => {
      pointer = null
      pressedCard = null
      pressedPointer = null
      schedule()
    }
    const click = (event: MouseEvent) => {
      if (!enabled || (event instanceof PointerEvent && event.detail > 0 && event.pointerType !== "mouse")) return
      const card = getCard(event.target)
      if (!card) return
      const rect = card.getBoundingClientRect()
      const x = event.detail === 0 ? rect.left + rect.width / 2 : event.clientX
      const y = event.detail === 0 ? rect.top + rect.height / 2 : event.clientY
      const bounds = container.getBoundingClientRect()
      borderWave = {
        x,
        y,
        start: performance.now(),
        reach:
          Math.max(
            Math.hypot(x - bounds.left, y - bounds.top),
            Math.hypot(x - bounds.right, y - bounds.top),
            Math.hypot(x - bounds.left, y - bounds.bottom),
            Math.hypot(x - bounds.right, y - bounds.bottom),
          ) + 80,
      }
      const spring = presses.get(card) ?? { scale: 1, velocity: 0 }
      // 快速点按可能在同一帧内完成，仍需呈现压下后回弹的反馈。
      if (spring.scale > 0.995) {
        spring.scale = 0.985
        spring.velocity = 0
      }
      presses.set(card, spring)
      card.style.setProperty("--magic-bento-scale", String(spring.scale))
      waves.forEach((_, wave) => {
        if (wave.parentElement === card) removeWave(wave)
      })
      const wave = document.createElement("span")
      const diameter = Math.hypot(rect.width, rect.height) * 2
      wave.className = "magic-bento-wave"
      wave.setAttribute("aria-hidden", "true")
      wave.style.setProperty("--magic-bento-wave-x", `${x - rect.left}px`)
      wave.style.setProperty("--magic-bento-wave-y", `${y - rect.top}px`)
      wave.style.setProperty("--magic-bento-wave-size", `${diameter}px`)
      wave.addEventListener("animationend", () => removeWave(wave), { once: true })
      card.append(wave)
      waves.set(
        wave,
        window.setTimeout(() => removeWave(wave), 900),
      )
      schedule()
    }

    // Ignore text updates and our decorative waves; only rescan changed card subtrees.
    const containsCard = (node: Node) =>
      node instanceof Element && (node.matches(cardSelector) || node.querySelector(cardSelector) !== null)
    const observer = new MutationObserver((records) => {
      if (records.some((record) => [...record.addedNodes, ...record.removedNodes].some(containsCard))) syncCards()
    })
    syncCards()
    syncPreference()
    observer.observe(container, { childList: true, subtree: true })
    container.addEventListener("pointermove", move, { passive: true })
    container.addEventListener("pointerdown", press, { passive: true })
    container.addEventListener("pointerleave", leave)
    container.addEventListener("click", click)
    window.addEventListener("pointerup", release, { passive: true })
    window.addEventListener("pointercancel", release, { passive: true })
    window.addEventListener("scroll", schedule, { capture: true, passive: true })
    window.addEventListener("resize", schedule, { passive: true })
    window.addEventListener("blur", reset)
    document.addEventListener("visibilitychange", syncPreference)
    finePointer.addEventListener("change", syncPreference)
    reducedMotion.addEventListener("change", syncPreference)

    return () => {
      observer.disconnect()
      container.removeEventListener("pointermove", move)
      container.removeEventListener("pointerdown", press)
      container.removeEventListener("pointerleave", leave)
      container.removeEventListener("click", click)
      window.removeEventListener("pointerup", release)
      window.removeEventListener("pointercancel", release)
      window.removeEventListener("scroll", schedule, true)
      window.removeEventListener("resize", schedule)
      window.removeEventListener("blur", reset)
      document.removeEventListener("visibilitychange", syncPreference)
      finePointer.removeEventListener("change", syncPreference)
      reducedMotion.removeEventListener("change", syncPreference)
      reset()
      cards.forEach((card) => card.removeAttribute(cardAttribute))
      delete container.dataset.magicBentoEnabled
    }
  }, [cardSelector])

  return (
    <div ref={containerRef} className={["magic-bento", className].filter(Boolean).join(" ")}>
      {children}
    </div>
  )
}
