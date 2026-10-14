import * as React from "react"
import { X } from "lucide-react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { cn } from "@/lib/utils"

const DialogOpenContext = React.createContext(false)
const dialogSpring = { type: "spring", stiffness: 400, damping: 30 } as const

export function Dialog({ open: controlledOpen, defaultOpen = false, onOpenChange, children, ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen)
  const open = controlledOpen ?? uncontrolledOpen
  return <DialogOpenContext.Provider value={open}><DialogPrimitive.Root {...props} open={open} onOpenChange={next => {
    if (controlledOpen === undefined) setUncontrolledOpen(next)
    onOpenChange?.(next)
  }}>{children}</DialogPrimitive.Root></DialogOpenContext.Provider>
}
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

export function DialogContent({ className, children, ...props }: React.ComponentProps<typeof DialogPrimitive.Content>) {
  const open = React.useContext(DialogOpenContext)
  const reducedMotion = useReducedMotion()
  return <DialogPrimitive.Portal forceMount>
    <AnimatePresence>
      {open && <DialogPrimitive.Overlay forceMount asChild key="overlay">
        <motion.div className="radix-overlay fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={dialogSpring}/>
      </DialogPrimitive.Overlay>}
      {open && <DialogPrimitive.Content {...props} forceMount asChild key="content">
        <motion.div className={cn("radix-dialog-content fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[2px] border border-[var(--border)] bg-[var(--surface-raised)] p-6 shadow-2xl outline-none sm:p-7", className)} initial={{ opacity: 0, scale: reducedMotion ? 1 : .98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: reducedMotion ? 1 : .99 }} transition={dialogSpring}>
          {children}
          <DialogPrimitive.Close className="absolute right-4 top-4 grid size-9 place-items-center rounded-[2px] text-[var(--muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40" aria-label="关闭">
            <X size={17}/>
          </DialogPrimitive.Close>
        </motion.div>
      </DialogPrimitive.Content>}
    </AnimatePresence>
  </DialogPrimitive.Portal>
}

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) { return <div className={cn("mb-6 grid gap-1.5 pr-10", className)} {...props}/> }
export function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) { return <DialogPrimitive.Title className={cn("text-xl font-semibold tracking-tight", className)} {...props}/> }
export function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) { return <DialogPrimitive.Description className={cn("text-sm leading-6 text-[var(--muted)]", className)} {...props}/> }
export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) { return <div className={cn("mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props}/> }
