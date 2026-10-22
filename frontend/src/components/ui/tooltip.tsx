import * as React from "react"
import { Tooltip as TooltipPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"
import { motion, useReducedMotion } from "motion/react"
import { spring } from "@/lib/motion"

export const TooltipProvider = TooltipPrimitive.Provider
export const Tooltip = TooltipPrimitive.Root
export const TooltipTrigger = TooltipPrimitive.Trigger
export function TooltipContent({
  className,
  sideOffset = 7,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  const reducedMotion = useReducedMotion()
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content sideOffset={sideOffset} {...props} asChild>
        <motion.div
          initial={reducedMotion ? false : { opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={reducedMotion ? { duration: 0 } : spring.snappy}
          className={cn(
            [
              "radix-tooltip-content z-[70] rounded-control border border-border bg-surface-raised px-2.5 py-1.5",
              "text-xs text-ink shadow-[0_12px_32px_rgba(0,0,0,.45)]",
            ].join(" "),
            className,
          )}
        >
          {children}
        </motion.div>
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}
