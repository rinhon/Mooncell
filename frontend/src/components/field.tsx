import type { ReactNode } from "react"

/** 统一表单标签、控件和辅助说明之间的间距与语义关联。 */
export function Field({ label, hint, hintPosition = "bottom", children }: { label: ReactNode; hint?: string; hintPosition?: "top" | "bottom"; children: ReactNode }) {
  return <label className="grid gap-1.5 text-sm font-medium text-[var(--ink)]">
    <span className="flex items-baseline justify-between gap-2"><span>{label}</span>{hint && hintPosition === "top" && <span className="text-right text-[13px] font-normal text-[var(--muted)]">{hint}</span>}</span>{children}{hint && hintPosition === "bottom" && <span className="text-[13px] font-normal text-[var(--muted)]">{hint}</span>}
  </label>
}
