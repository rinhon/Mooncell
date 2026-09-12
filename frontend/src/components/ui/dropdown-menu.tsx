import * as React from "react"
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"

export const DropdownMenu = DropdownMenuPrimitive.Root
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger

export function DropdownMenuContent({ className, sideOffset = 6, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return <DropdownMenuPrimitive.Portal><DropdownMenuPrimitive.Content sideOffset={sideOffset} className={cn("z-[70] min-w-36 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1 shadow-xl", className)} {...props}/></DropdownMenuPrimitive.Portal>
}

export function DropdownMenuItem({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Item>) {
  return <DropdownMenuPrimitive.Item className={cn("flex cursor-default select-none items-center gap-2 rounded-lg px-3 py-2 text-sm text-[var(--ink)] outline-none transition data-[highlighted]:bg-[var(--surface-raised)] data-[disabled]:opacity-50", className)} {...props}/>
}
