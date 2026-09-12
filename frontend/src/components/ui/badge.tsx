import * as React from "react"
import { cn } from "@/lib/utils"

export function Badge({ className, tone = "neutral", ...props }: React.HTMLAttributes<HTMLSpanElement> & { tone?: "neutral" | "success" | "warning" | "danger" }) {
  const tones = { neutral: "bg-[var(--surface-raised)] text-[var(--muted)]", success: "bg-[var(--accent-soft)] text-[var(--accent)]", warning: "bg-amber-500/10 text-[var(--warning)]", danger: "bg-red-500/10 text-[var(--danger)]" }
  return <span data-slot="badge" data-tone={tone} className={cn("inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium", tones[tone], className)} {...props} />
}
