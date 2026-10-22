import * as React from "react"
import { cn } from "@/lib/utils"

export function Badge({ className, tone = "neutral", ...props }: React.HTMLAttributes<HTMLSpanElement> & { tone?: "neutral" | "success" | "warning" | "danger" }) {
  const tones = {
    neutral: "border-[var(--border-soft)] text-[var(--ink-2)]",
    success: "border-[color-mix(in_oklab,var(--success)_28%,transparent)] text-[var(--success)]",
    warning: "border-[var(--warning-line)] text-[var(--warning)]",
    danger: "border-[var(--danger-line)] text-[var(--danger)]",
  }
  return <span data-slot="badge" data-tone={tone} className={cn("inline-flex items-center rounded-[var(--radius-inset)] border bg-white/[.04] px-2.5 py-1 text-xs font-medium tracking-[.02em]", tones[tone], className)} {...props} />
}
