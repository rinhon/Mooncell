import { spring } from "@/lib/motion"
import * as React from "react"
import { Popover as Primitive } from "radix-ui"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { cn } from "@/lib/utils"

const PopoverOpenContext = React.createContext(false)
const popoverSpring = spring.snappy

export function Popover({
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  children,
  ...props
}: React.ComponentProps<typeof Primitive.Root>) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen)
  const open = controlledOpen ?? uncontrolledOpen
  return (
    <PopoverOpenContext.Provider value={open}>
      <Primitive.Root
        {...props}
        open={open}
        onOpenChange={(next) => {
          if (controlledOpen === undefined) setUncontrolledOpen(next)
          onOpenChange?.(next)
        }}
      >
        {children}
      </Primitive.Root>
    </PopoverOpenContext.Provider>
  )
}

export const PopoverTrigger = Primitive.Trigger
export const PopoverClose = Primitive.Close
export const PopoverContent = React.forwardRef<
  React.ElementRef<typeof Primitive.Content>,
  React.ComponentPropsWithoutRef<typeof Primitive.Content>
>(({ className, align = "end", sideOffset = 12, children, ...props }, ref) => {
  const open = React.useContext(PopoverOpenContext)
  const reducedMotion = useReducedMotion()
  return (
    <Primitive.Portal forceMount>
      <AnimatePresence>
        {open && (
          <Primitive.Content
            ref={ref}
            align={align}
            sideOffset={sideOffset}
            collisionPadding={12}
            forceMount
            asChild
            {...props}
          >
            <motion.div
              className={cn("notification-panel transform-gpu", className)}
              style={{ transformOrigin: "var(--radix-popover-content-transform-origin)" }}
              initial={reducedMotion ? false : { opacity: 0, scale: 0.96, y: -6 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: -3 }}
              transition={
                reducedMotion
                  ? { duration: 0 }
                  : {
                      scale: popoverSpring,
                      y: popoverSpring,
                      opacity: spring.snappy,
                    }
              }
            >
              {children}
            </motion.div>
          </Primitive.Content>
        )}
      </AnimatePresence>
    </Primitive.Portal>
  )
})
PopoverContent.displayName = "PopoverContent"
