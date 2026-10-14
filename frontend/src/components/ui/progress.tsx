import * as React from "react"
import { Progress as ProgressPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"

export function Progress({ value = 0, className, indicatorClassName, ...props }: React.ComponentProps<typeof ProgressPrimitive.Root> & { indicatorClassName?: string }) {
  const normalizedValue = value ?? 0
  return <ProgressPrimitive.Root data-slot="progress" value={normalizedValue} className={cn("relative h-[2px] w-full overflow-hidden bg-[rgba(237,240,238,.18)]", className)} {...props}><ProgressPrimitive.Indicator data-slot="progress-indicator" className={cn("h-full bg-[var(--accent)] transition-transform duration-500 ease-out", indicatorClassName)} style={{ transform: `translateX(-${100 - normalizedValue}%)` }}/></ProgressPrimitive.Root>
}
