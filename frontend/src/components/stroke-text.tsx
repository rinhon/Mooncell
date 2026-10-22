// React Bits Stroke Text — https://reactbits.dev/text-animations/stroke-text
// License: ./stroke-text.LICENSE. Animation uses the shared Motion runtime.
import { type CSSProperties, useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import { motion, useInView, useReducedMotion } from "motion/react"
import { spring } from "@/lib/motion"
import "./StrokeText.css"

export type StrokeTextTrigger = "mount" | "hover" | "scroll" | "loop"
export type StrokeTextFillMode = "wipe" | "fade" | "none"
export interface StrokeTextProps {
  text?: string
  strokeColor?: string
  fillColor?: string
  strokeWidth?: number
  drawDuration?: number
  fillDelay?: number
  stagger?: number
  ease?: string
  trigger?: StrokeTextTrigger
  playOnMount?: boolean
  fillMode?: StrokeTextFillMode
  fontSize?: number
  fontWeight?: number | string
  letterSpacing?: number
  reverse?: boolean
  className?: string
  style?: CSSProperties
}

interface StrokeTextBox {
  x: number
  y: number
  width: number
  height: number
}

export default function StrokeText({
  text = "MOONCELL",
  strokeColor = "var(--accent)",
  fillColor = "var(--ink)",
  strokeWidth = 1.4,
  fillDelay = 0.1,
  stagger = 0.035,
  trigger = "mount",
  playOnMount = false,
  fillMode = "wipe",
  fontSize = 128,
  fontWeight = 800,
  letterSpacing = -4,
  reverse = false,
  className = "",
  style = {},
}: StrokeTextProps) {
  const rootRef = useRef<HTMLSpanElement>(null)
  const textRef = useRef<SVGTextElement>(null)
  const [box, setBox] = useState<StrokeTextBox | null>(null)
  const [replay, setReplay] = useState(0)
  const reduce = useReducedMotion()
  const inView = useInView(rootRef, { once: true })
  const rawId = useId()
  const wipeId = `stroke-text-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`
  const characters = useMemo(() => Array.from(text), [text])
  const dash = Math.max(fontSize * 7, 200)
  const fontStyle = { fontSize, fontWeight, letterSpacing } as CSSProperties
  const playing = !reduce && (trigger === "scroll" ? inView : trigger !== "hover" || playOnMount || replay > 0)

  useLayoutEffect(() => {
    let cancelled = false
    const measure = () => {
      if (cancelled || !textRef.current) return
      const bounds = textRef.current.getBBox()
      if (!bounds.width) return
      const pad = Math.max(strokeWidth, fontSize * 0.1)
      setBox({ x: bounds.x - pad, y: bounds.y - pad, width: bounds.width + 2 * pad, height: bounds.height + 2 * pad })
    }
    measure()
    void document.fonts.ready.then(measure)
    return () => {
      cancelled = true
    }
  }, [text, fontSize, fontWeight, letterSpacing, strokeWidth])

  const replayHover = () => {
    if (trigger === "hover" && !reduce) setReplay((value) => value + 1)
  }
  const repeat = trigger === "loop" && !reduce ? Infinity : 0
  return (
    <span
      ref={rootRef}
      className={`stroke-text ${className}`}
      style={{ ...style, "--stroke-text-height": `${Math.round(fontSize * 1.3)}px` } as CSSProperties}
      role="img"
      aria-label={text}
      onPointerEnter={replayHover}
      onFocus={replayHover}
    >
      <svg
        className="stroke-text__svg"
        viewBox={box ? `${box.x} ${box.y} ${box.width} ${box.height}` : `0 ${-fontSize} 600 ${fontSize * 1.3}`}
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
      >
        {fillMode === "wipe" && box && (
          <defs>
            <clipPath id={wipeId} clipPathUnits="userSpaceOnUse">
              <motion.rect
                key={`wipe-${replay}`}
                x={box.x}
                y={box.y}
                height={box.height}
                initial={playing ? { width: 0 } : false}
                animate={{ width: box.width }}
                transition={
                  playing ? { ...spring.gentle, delay: 0.25 + fillDelay, repeat, repeatDelay: 1 } : { duration: 0 }
                }
              />
            </clipPath>
          </defs>
        )}
        <text
          ref={textRef}
          className="stroke-text__stroke"
          x="0"
          y="0"
          fill="none"
          stroke={strokeColor}
          strokeWidth={strokeWidth}
          strokeLinejoin="round"
          strokeLinecap="round"
          style={fontStyle}
        >
          {characters.map((char, index) => (
            <motion.tspan
              key={`s-${replay}-${index}`}
              strokeDasharray={dash}
              initial={playing ? { strokeDashoffset: dash } : false}
              animate={{ strokeDashoffset: 0 }}
              transition={
                playing
                  ? {
                      ...spring.gentle,
                      delay: (reverse ? characters.length - index - 1 : index) * stagger,
                      repeat,
                      repeatDelay: 1,
                    }
                  : { duration: 0 }
              }
            >
              {char}
            </motion.tspan>
          ))}
        </text>
        {fillMode !== "none" && (
          <motion.text
            key={`f-${replay}`}
            className="stroke-text__fill"
            x="0"
            y="0"
            fill={fillColor}
            stroke="none"
            style={fontStyle}
            clipPath={fillMode === "wipe" && box ? `url(#${wipeId})` : undefined}
            initial={playing && fillMode === "fade" ? { opacity: 0 } : false}
            animate={{ opacity: 1 }}
            transition={
              playing ? { ...spring.gentle, delay: 0.25 + fillDelay, repeat, repeatDelay: 1 } : { duration: 0 }
            }
          >
            {text}
          </motion.text>
        )}
      </svg>
    </span>
  )
}
