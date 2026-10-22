import * as React from "react"
import { cn } from "@/lib/utils"

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      data-slot="input"
      className={cn(
        [
          "h-10 w-full rounded-control border border-border bg-surface px-3 text-sm text-ink outline-none",
          "transition-colors placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-accent/15",
        ].join(" "),
        className,
      )}
      {...props}
    />
  )
}
