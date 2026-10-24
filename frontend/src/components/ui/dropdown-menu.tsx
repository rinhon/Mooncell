import { spring } from "@/lib/motion"
import * as React from "react"
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { cn } from "@/lib/utils"

const DropdownMenuOpenContext = React.createContext(false)

export function DropdownMenu({
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  modal = false,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen)
  const open = controlledOpen ?? uncontrolledOpen
  return (
    <DropdownMenuOpenContext.Provider value={open}>
      <DropdownMenuPrimitive.Root
        {...props}
        modal={modal}
        open={open}
        onOpenChange={(next) => {
          if (controlledOpen === undefined) setUncontrolledOpen(next)
          onOpenChange?.(next)
        }}
      >
        {children}
      </DropdownMenuPrimitive.Root>
    </DropdownMenuOpenContext.Provider>
  )
}
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger

const menuSpring = spring.snappy

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  children,
  animateSize: _animateSize = false,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content> & { animateSize?: boolean }) {
  const open = React.useContext(DropdownMenuOpenContext)
  const reducedMotion = useReducedMotion()
  const surfaceClassName = cn(
    [
      "z-[70] min-w-36 overflow-hidden rounded-card border border-border bg-navigation-background p-1",
      "shadow-xl backdrop-blur-md",
    ].join(" "),
    className,
  )

  return (
    <DropdownMenuPrimitive.Portal forceMount>
      <AnimatePresence>
        {open && (
          <DropdownMenuPrimitive.Content {...props} sideOffset={sideOffset} forceMount asChild key="content">
            <motion.div
              className={cn(surfaceClassName, "transform-gpu data-[state=closed]:pointer-events-none")}
              style={{ transformOrigin: "var(--radix-dropdown-menu-content-transform-origin)" }}
              initial={reducedMotion ? false : { opacity: 0, scale: 0.96, y: -4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: -2 }}
              transition={
                reducedMotion
                  ? { duration: 0 }
                  : {
                      scale: menuSpring,
                      y: menuSpring,
                      opacity: spring.snappy,
                    }
              }
            >
              {children}
            </motion.div>
          </DropdownMenuPrimitive.Content>
        )}
      </AnimatePresence>
    </DropdownMenuPrimitive.Portal>
  )
}

export function DropdownMenuItem({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Item>) {
  return (
    <DropdownMenuPrimitive.Item
      className={cn(
        [
          "flex cursor-default select-none items-center gap-2 rounded-inset px-3 py-2 text-sm text-ink",
          "outline-none transition-colors data-[highlighted]:bg-accent-soft data-[highlighted]:text-accent",
          "data-[disabled]:opacity-50",
        ].join(" "),
        className,
      )}
      {...props}
    />
  )
}
