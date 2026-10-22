// Adapted from React Bits Gradual Blur (https://reactbits.dev/c/animations/gradual-blur)
import { useMemo, type CSSProperties } from "react"
import { cn } from "@/lib/utils"

export type GradualBlurPosition = "top" | "bottom" | "left" | "right"
export type GradualBlurCurve = "linear" | "bezier" | "ease-in" | "ease-out" | "ease-in-out"

export interface GradualBlurProps {
  position?: GradualBlurPosition
  strength?: number
  height?: string
  width?: string
  divCount?: number
  exponential?: boolean
  curve?: GradualBlurCurve
  opacity?: number
  zIndex?: number
  target?: "parent" | "page"
  tint?: string
  className?: string
  style?: CSSProperties
}

const CURVE_FUNCTIONS: Record<GradualBlurCurve, (p: number) => number> = {
  linear: p => p,
  bezier: p => p * p * (3 - 2 * p),
  "ease-in": p => p * p,
  "ease-out": p => 1 - Math.pow(1 - p, 2),
  "ease-in-out": p => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2),
}

const DIRECTION_MAP: Record<GradualBlurPosition, string> = {
  top: "to top",
  bottom: "to bottom",
  left: "to left",
  right: "to right",
}

export function GradualBlur({
  position = "bottom",
  strength = 2,
  height = "6rem",
  width,
  divCount = 5,
  exponential = true,
  curve = "bezier",
  opacity = 1,
  zIndex,
  target = "parent",
  tint,
  className,
  style,
}: GradualBlurProps) {
  const isVertical = position === "top" || position === "bottom"
  const direction = DIRECTION_MAP[position]
  const curveFn = CURVE_FUNCTIONS[curve] ?? CURVE_FUNCTIONS.bezier

  const layers = useMemo(() => {
    const count = Math.max(1, Math.min(10, divCount))
    const increment = 100 / count
    const result: CSSProperties[] = []

    for (let i = 1; i <= count; i++) {
      const progress = curveFn(i / count)
      const blurRem = exponential
        ? Math.pow(2, progress * 4) * 0.0625 * strength
        : 0.0625 * (progress * count + 1) * strength

      const rawP1 = Math.round((increment * i - increment) * 10) / 10
      const p1 = i === 1 ? Math.min(8, increment * 0.35) : rawP1
      const p2 = Math.round(increment * i * 10) / 10
      const p3 = Math.round((increment * i + increment) * 10) / 10
      const p4 = Math.round((increment * i + increment * 2) * 10) / 10

      let stops = i === 1 ? `transparent 0%, transparent ${p1}%, black ${p2}%` : `transparent ${p1}%, black ${p2}%`
      if (p3 <= 100) stops += `, black ${p3}%`
      if (p4 <= 100) stops += `, transparent ${p4}%`

      const mask = `linear-gradient(${direction}, ${stops})`
      const blur = `blur(${blurRem.toFixed(3)}rem)`

      result.push({
        position: "absolute",
        inset: 0,
        maskImage: mask,
        WebkitMaskImage: mask,
        backdropFilter: blur,
        WebkitBackdropFilter: blur,
        opacity,
      })
    }

    return result
  }, [curveFn, direction, divCount, exponential, opacity, strength])

  const containerStyle: CSSProperties = {
    position: target === "page" ? "fixed" : "absolute",
    pointerEvents: "none",
    zIndex,
    ...(isVertical
      ? {
          height,
          width: width ?? "100%",
          left: 0,
          right: 0,
          [position]: 0,
        }
      : {
          width: width ?? height,
          height: "100%",
          top: 0,
          bottom: 0,
          [position]: 0,
        }),
    ...style,
  }

  return (
    <div
      aria-hidden="true"
      className={cn("gradual-blur select-none", className)}
      style={containerStyle}
    >
      <div className="relative size-full">
        {layers.map((layerStyle, index) => (
          <div key={index} style={layerStyle} />
        ))}
        {tint && (
          <div
            className="absolute inset-0"
            style={{ background: tint }}
          />
        )}
      </div>
    </div>
  )
}
