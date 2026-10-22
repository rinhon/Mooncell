import type { ButtonHTMLAttributes } from "react"
import { type LucideIcon } from "lucide-react"
import { Button, type ButtonProps } from "@/components/ui/button"

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon
  pending?: boolean
  pendingLabel: string
  emphasis?: "primary" | "secondary"
  size?: ButtonProps["size"]
}

export function ActionButton({
  icon: Icon,
  pending = false,
  pendingLabel,
  emphasis = "primary",
  disabled,
  className,
  children,
  type = "button",
  ...props
}: Props) {
  return (
    <Button
      {...props}
      type={type}
      disabled={disabled}
      pending={pending}
      pendingLabel={pendingLabel}
      icon={Icon}
      iconSlot
      variant={emphasis === "primary" ? "default" : "secondary"}
      className={className}
    >
      {children}
    </Button>
  )
}
