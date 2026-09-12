import * as React from "react"
import { X } from "lucide-react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

export function DialogContent({ className, children, ...props }: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className="radix-overlay fixed inset-0 z-50 bg-zinc-950/35 backdrop-blur-sm" />
    <DialogPrimitive.Content className={cn("radix-dialog-content fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-3xl border border-[var(--border)] bg-[var(--surface-raised)] p-6 shadow-2xl outline-none sm:p-7", className)} {...props}>
      {children}
      <DialogPrimitive.Close className="absolute right-4 top-4 grid size-9 place-items-center rounded-xl text-[var(--muted)] transition   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40" aria-label="关闭">
        <X size={17}/>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
}

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) { return <div className={cn("mb-6 grid gap-1.5 pr-10", className)} {...props}/> }
export function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) { return <DialogPrimitive.Title className={cn("text-xl font-semibold tracking-tight", className)} {...props}/> }
export function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) { return <DialogPrimitive.Description className={cn("text-sm leading-6 text-[var(--muted)]", className)} {...props}/> }
export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) { return <div className={cn("mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props}/> }
