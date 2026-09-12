import * as React from "react"
import { cn } from "@/lib/utils"

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input data-slot="input" className={cn("h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--ink)] outline-none placeholder:text-[var(--muted)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/15", className)} {...props} />
}
