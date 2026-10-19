import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react"
import { Popover as Primitive } from "radix-ui"
import { cn } from "@/lib/utils"

export const Popover = Primitive.Root
export const PopoverTrigger = Primitive.Trigger
export const PopoverClose = Primitive.Close
export const PopoverContent = forwardRef<ElementRef<typeof Primitive.Content>, ComponentPropsWithoutRef<typeof Primitive.Content>>(
  ({ className, align = "end", sideOffset = 12, ...props }, ref) =>
    <Primitive.Portal><Primitive.Content ref={ref} align={align} sideOffset={sideOffset} collisionPadding={12} className={cn("notification-panel", className)} {...props}/></Primitive.Portal>,
)
PopoverContent.displayName = "PopoverContent"
