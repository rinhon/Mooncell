import * as React from "react"
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { cn } from "@/lib/utils"

const DropdownMenuOpenContext = React.createContext(false)

export function DropdownMenu({ open: controlledOpen, defaultOpen = false, onOpenChange, children, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen)
  const open = controlledOpen ?? uncontrolledOpen
  return <DropdownMenuOpenContext.Provider value={open}><DropdownMenuPrimitive.Root {...props} open={open} onOpenChange={next => {
    if (controlledOpen === undefined) setUncontrolledOpen(next)
    onOpenChange?.(next)
  }}>{children}</DropdownMenuPrimitive.Root></DropdownMenuOpenContext.Provider>
}
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger

export function DropdownMenuContent({ className, sideOffset = 6, children, animateSize = false, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Content> & { animateSize?: boolean }) {
  const open = React.useContext(DropdownMenuOpenContext)
  const reducedMotion = useReducedMotion()
  const surfaceClassName = cn("z-[70] min-w-36 overflow-hidden rounded-[2px] border border-[var(--border)] bg-[var(--surface)] p-1 shadow-xl", className)
  if (!animateSize) return <DropdownMenuPrimitive.Portal><DropdownMenuPrimitive.Content sideOffset={sideOffset} className={surfaceClassName} {...props}>{children}</DropdownMenuPrimitive.Content></DropdownMenuPrimitive.Portal>

  return <DropdownMenuPrimitive.Portal forceMount><AnimatePresence>
    {open && <DropdownMenuPrimitive.Content {...props} sideOffset={sideOffset} forceMount asChild key="content">
      <motion.div
        className={cn(surfaceClassName, "data-[state=closed]:pointer-events-none")}
        style={{ transformOrigin: "var(--radix-dropdown-menu-content-transform-origin)" }}
        initial={reducedMotion ? false : { height: 0, opacity: 0 }}
        animate={{ height: "auto", opacity: 1 }}
        exit={{ height: reducedMotion ? "auto" : 0, opacity: 0 }}
        transition={{
          height: { duration: reducedMotion ? 0 : open ? .3 : .22, ease: [.22, 1, .36, 1] },
          opacity: { duration: reducedMotion ? 0 : .16 },
        }}
      >{children}</motion.div>
    </DropdownMenuPrimitive.Content>}
  </AnimatePresence></DropdownMenuPrimitive.Portal>
}

export function DropdownMenuItem({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Item>) {
  return <DropdownMenuPrimitive.Item className={cn("flex cursor-default select-none items-center gap-2 rounded-[2px] px-3 py-2 text-sm text-[var(--ink)] outline-none transition data-[highlighted]:bg-[var(--surface-raised)] data-[disabled]:opacity-50", className)} {...props}/>
}
