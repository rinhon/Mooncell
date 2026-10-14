import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"
import { LoaderCircle, type LucideIcon } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "ui-button relative isolate inline-flex shrink-0 items-center justify-center gap-2 overflow-hidden whitespace-nowrap rounded-[2px] border text-sm font-medium disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
  { variants: {
      variant: {
        default: "border-[var(--accent)] bg-[var(--accent)] text-[var(--on-accent)]",
        outline: "border-[var(--accent)] bg-transparent text-[var(--accent)]",
        secondary: "border-[var(--border)] bg-[var(--surface)] text-[var(--ink-2)]",
        ghost: "border-transparent bg-transparent text-[var(--muted)]",
        danger: "border-[var(--danger-line)] bg-[var(--danger-soft)] text-[var(--danger)]",
      },
      size: { default: "h-10 px-4", sm: "h-8 px-3 text-xs", lg: "h-12 px-6 text-base", icon: "size-10 p-0", "icon-sm": "size-8 p-0" },
    }, defaultVariants: { variant: "default", size: "default" } }
)

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean
  icon?: LucideIcon
  iconSlot?: boolean
  iconMotion?: "rotate" | "refresh"
  pending?: boolean
  pendingLabel?: string
}
function buttonContent(children: React.ReactNode) {
  return React.Children.map(children, (child) => typeof child === "string" || typeof child === "number" ? <span className="button-label">{child}</span> : child)
}

export function NativeButton({ children, ...props }: React.ComponentProps<"button">) {
  return <button {...props}>{buttonContent(children)}</button>
}

const buttonSpring = { type: "spring", stiffness: 500, damping: 40 } as const

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button({ className, variant = "default", size = "default", asChild, children, icon: Icon, iconSlot, iconMotion, pending, pendingLabel, disabled, ...props }, ref) {
  const reducedMotion = useReducedMotion()
  const [hovered, setHovered] = React.useState(false)
  const [focused, setFocused] = React.useState(false)
  const inactive = Boolean(disabled || pending)
  const label = pending && pendingLabel ? pendingLabel : asChild && React.isValidElement<{ children?: React.ReactNode }>(children) ? children.props.children : children
  const inner = <>
    <motion.span className="ui-button-fill" aria-hidden="true" initial={false} animate={{ scaleX: !inactive && (hovered || focused) ? 1 : 0 }} transition={reducedMotion ? { duration: 0 } : buttonSpring}/>
    {(Icon || pending) && <motion.span className="ui-button-icon" aria-hidden="true" initial={false} animate={{ rotate: !reducedMotion && !inactive && hovered ? iconMotion === "refresh" ? 180 : iconMotion === "rotate" ? 90 : 0 : 0 }} transition={buttonSpring}>{pending ? <LoaderCircle size={16} className="motion-safe:animate-spin"/> : Icon && <Icon size={16}/>}</motion.span>}
    <span className="button-label">{label}</span>
  </>
  const content = asChild && React.isValidElement<{ children?: React.ReactNode }>(children)
    ? React.cloneElement(children, {}, inner)
    : inner
  const sharedProps = {
    "data-slot": "button",
    "data-variant": variant,
    "data-size": size,
    "data-icon-slot": iconSlot || undefined,
    "data-icon-motion": iconMotion,
    "data-as-child": asChild || undefined,
    className: cn(buttonVariants({ variant, size }), className),
    disabled: inactive,
    "aria-busy": pending || undefined,
    onPointerEnter: (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.pointerType === "mouse" && window.matchMedia("(hover: hover) and (pointer: fine)").matches) setHovered(true)
      props.onPointerEnter?.(event)
    },
    onPointerLeave: (event: React.PointerEvent<HTMLButtonElement>) => { setHovered(false); props.onPointerLeave?.(event) },
    onPointerCancel: (event: React.PointerEvent<HTMLButtonElement>) => { setHovered(false); props.onPointerCancel?.(event) },
    onFocus: (event: React.FocusEvent<HTMLButtonElement>) => { setFocused(event.currentTarget.matches(":focus-visible")); props.onFocus?.(event) },
    onBlur: (event: React.FocusEvent<HTMLButtonElement>) => { setFocused(false); props.onBlur?.(event) },
  }
  if (asChild) return <Slot.Slot {...props} {...sharedProps} ref={ref}>{content}</Slot.Slot>
  return <motion.button {...props as React.ComponentProps<typeof motion.button>} {...sharedProps} ref={ref} whileTap={reducedMotion || inactive ? undefined : { scale: .97 }} transition={buttonSpring}>{content}</motion.button>
})
