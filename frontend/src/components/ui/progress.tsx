import { spring } from "@/lib/motion"
import * as React from "react"
import { Progress as ProgressPrimitive } from "radix-ui"
import { motion, useReducedMotion } from "motion/react"
import { cn } from "@/lib/utils"

const progressSpring = spring.gentle

export function Progress({
  value = 0,
  className,
  indicatorClassName,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> & { indicatorClassName?: string }) {
  const normalizedValue = Math.min(100, Math.max(0, value ?? 0))
  const reducedMotion = useReducedMotion()
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={normalizedValue}
      className={cn("relative h-[3px] w-full overflow-hidden rounded-full bg-border", className)}
      {...props}
    >
      <ProgressPrimitive.Indicator asChild data-slot="progress-indicator">
        <motion.div
          initial={false}
          className={cn("h-full w-full origin-left bg-accent transform-gpu", indicatorClassName)}
          animate={{ scaleX: normalizedValue / 100 }}
          transition={reducedMotion ? { duration: 0 } : progressSpring}
        />
      </ProgressPrimitive.Indicator>
    </ProgressPrimitive.Root>
  )
}
