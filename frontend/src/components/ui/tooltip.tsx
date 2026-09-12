import * as React from "react"
import { Tooltip as TooltipPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"

export const TooltipProvider = TooltipPrimitive.Provider
export const Tooltip = TooltipPrimitive.Root
export const TooltipTrigger = TooltipPrimitive.Trigger
export function TooltipContent({ className, sideOffset = 7, ...props }: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return <TooltipPrimitive.Portal><TooltipPrimitive.Content sideOffset={sideOffset} className={cn("radix-tooltip-content z-[70] rounded-lg bg-zinc-950 px-2.5 py-1.5 text-xs text-white shadow-lg", className)} {...props}/></TooltipPrimitive.Portal>
}
