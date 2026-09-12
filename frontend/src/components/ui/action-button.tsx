import type { ButtonHTMLAttributes } from "react"
import { LoaderCircle, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon
  pending?: boolean
  pendingLabel: string
  emphasis?: "primary" | "secondary"
}

export function ActionButton({ icon: Icon, pending = false, pendingLabel, emphasis = "primary", disabled, className, children, type = "button", ...props }: Props) {
  return <button {...props} type={type} disabled={disabled || pending} aria-busy={pending} data-emphasis={emphasis} className={cn("settings-action", className)}>
    <span className="settings-action-icon" aria-hidden="true">{pending ? <LoaderCircle size={16} className="motion-safe:animate-spin"/> : <Icon size={16}/>}</span>
    <span className="settings-action-label">{pending ? pendingLabel : children}</span>
  </button>
}
