import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"
import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium transition-[transform,background-color,color,box-shadow] duration-200 ease-out  active:translate-y-0 active:scale-[.97] disabled:pointer-events-none disabled:translate-y-0 disabled:opacity-50 motion-reduce:transform-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40",
  { variants: {
      variant: {
        default: "bg-[var(--accent)] text-[var(--on-accent)] hover:bg-[var(--accent-hover)] shadow-sm ",
        secondary: "bg-[var(--surface)] text-[var(--ink)] ring-1 ring-[var(--border)] ",
        ghost: "text-[var(--muted)]  ",
        danger: "bg-red-500/10 text-[var(--danger)] ring-1 ring-red-100 ",
      },
      size: { default: "h-10 px-4", sm: "h-8 rounded-lg px-3 text-xs", icon: "size-10 p-0" },
    }, defaultVariants: { variant: "default", size: "default" } }
)

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> { asChild?: boolean }
function buttonContent(children: React.ReactNode) {
  return React.Children.map(children, (child) => typeof child === "string" || typeof child === "number" ? <span className="button-label">{child}</span> : child)
}

export function NativeButton({ children, ...props }: React.ComponentProps<"button">) {
  return <button {...props}>{buttonContent(children)}</button>
}

export function Button({ className, variant, size, asChild, children, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Slot : "button"
  const content = asChild && React.isValidElement<{ children?: React.ReactNode }>(children)
    ? React.cloneElement(children, {}, buttonContent(children.props.children))
    : buttonContent(children)
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size }), className)} {...props}>{content}</Comp>
}
