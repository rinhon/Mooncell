import { spring } from "@/lib/motion"
import * as React from "react"
import { Check, ChevronDown } from "lucide-react"
import { Select as SelectPrimitive } from "radix-ui"
import { motion, useReducedMotion } from "motion/react"
import { cn } from "@/lib/utils"

const selectSpring = spring.snappy

export const Select = SelectPrimitive.Root
export const SelectValue = SelectPrimitive.Value

export function SelectTrigger({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        [
          "flex h-10 w-full items-center justify-between rounded-control border border-border bg-surface px-3",
          "text-sm outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/15",
          "data-[placeholder]:text-muted",
        ].join(" "),
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown size={15} className="text-muted" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

export function SelectContent({
  className,
  children,
  position = "popper",
  portalContainer,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content> & {
  portalContainer?: React.ComponentProps<typeof SelectPrimitive.Portal>["container"]
}) {
  const reducedMotion = useReducedMotion()
  return (
    <SelectPrimitive.Portal container={portalContainer}>
      <SelectPrimitive.Content position={position} sideOffset={6} asChild {...props}>
        <motion.div
          style={{ transformOrigin: "var(--radix-select-content-transform-origin)" }}
          initial={reducedMotion ? false : { opacity: 0, scale: 0.96, y: -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={
            reducedMotion ? { duration: 0 } : { scale: selectSpring, y: selectSpring, opacity: spring.snappy }
          }
          className={cn(
            [
              "radix-select-content z-[60] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-card",
              "border border-border bg-navigation-background p-1 shadow-xl backdrop-blur-md transform-gpu",
            ].join(" "),
            className,
          )}
        >
          <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
        </motion.div>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

export function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        [
          "relative flex cursor-default select-none items-center rounded-inset py-2 pl-8 pr-3 text-sm text-ink",
          "outline-none transition-colors data-[highlighted]:bg-accent-soft data-[highlighted]:text-accent",
          "data-[disabled]:opacity-50",
        ].join(" "),
        className,
      )}
      {...props}
    >
      <span className="absolute left-2.5 grid size-4 place-items-center">
        <SelectPrimitive.ItemIndicator>
          <Check size={14} />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
}
