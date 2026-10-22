// Adapted from Magic UI's Blur Fade. See blur-fade.LICENSE.
import { useContext, useRef } from "react"
import { motion, useInView, useReducedMotion, type MotionProps, type UseInViewOptions } from "motion/react"
import { spring } from "@/lib/motion"
import { PageMotionContext } from "@/lib/page-motion"

interface BlurFadeProps extends MotionProps {
  children: React.ReactNode
  className?: string
  variant?: { hidden: { y: number }; visible: { y: number } }
  /** 兼容旧调用；入场速度由统一 Spring 决定，不再动画模糊滤镜。 */
  duration?: number
  blur?: string
  delay?: number
  offset?: number
  direction?: "up" | "down" | "left" | "right"
  inView?: boolean
  inViewMargin?: UseInViewOptions["margin"]
}

export function BlurFade({
  children,
  className,
  variant,
  duration: _duration,
  blur: _blur,
  delay = 0,
  offset = 6,
  direction = "down",
  inView = false,
  inViewMargin = "-50px",
  ...props
}: BlurFadeProps) {
  const ref = useRef(null)
  const reducedMotion = useReducedMotion()
  const { animateEntry } = useContext(PageMotionContext)
  const visible = useInView(ref, { once: true, margin: inViewMargin })
  const skip = reducedMotion || !animateEntry
  const axis = direction === "left" || direction === "right" ? "x" : "y"
  return (
    <motion.div
      {...props}
      ref={ref}
      initial={skip ? false : "hidden"}
      animate={skip || !inView || visible ? "visible" : "hidden"}
      variants={
        variant ?? {
          hidden: { [axis]: direction === "right" || direction === "down" ? -offset : offset, opacity: 0 },
          visible: { [axis]: 0, opacity: 1 },
        }
      }
      transition={skip ? { duration: 0 } : { ...spring.gentle, delay }}
      className={className}
    >
      {children}
    </motion.div>
  )
}
