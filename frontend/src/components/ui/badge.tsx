import * as React from "react"
import { cn } from "@/lib/utils"

export function Badge({
  className,
  tone = "neutral",
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: "neutral" | "success" | "warning" | "danger" }) {
  const tones = {
    neutral: "border-border-soft text-ink-2",
    success: "border-[color-mix(in_oklab,var(--success)_28%,transparent)] text-success",
    warning: "border-[var(--warning-line)] text-warning",
    danger: "border-[var(--danger-line)] text-danger",
  }
  return (
    <span
      data-slot="badge"
      data-tone={tone}
      className={cn(
        "inline-flex items-center rounded-inset border bg-white/[.04] px-2.5 py-1 text-xs font-medium tracking-[.02em]",
        tones[tone],
        className,
      )}
      {...props}
    />
  )
}
