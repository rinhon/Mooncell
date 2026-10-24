import { forwardRef, type ButtonHTMLAttributes } from "react"
import { motion, useReducedMotion, type HTMLMotionProps } from "motion/react"
import { LoaderCircle, Plus } from "lucide-react"
import { Link } from "react-router-dom"
import { cn } from "@/lib/utils"
import { spring } from "@/lib/motion"
import "./add-subscription-button.css"

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { to?: string; pending?: boolean }
const MotionLink = motion.create(Link)

export const AddSubscriptionButton = forwardRef<HTMLButtonElement, Props>(function AddSubscriptionButton(
  { to, pending, className, disabled, ...props },
  ref,
) {
  const reducedMotion = useReducedMotion()
  const interaction = {
    whileTap: reducedMotion || disabled || pending ? undefined : { scale: 0.98 },
    transition: reducedMotion ? { duration: 0 } : spring.press,
  }
  const classes = cn(
    [
      "add-subscription-button relative isolate inline-flex shrink-0 items-center justify-center",
      "overflow-hidden whitespace-nowrap rounded-control border border-accent bg-transparent text-sm",
      "font-medium text-accent disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2",
      "focus-visible:outline-offset-2 focus-visible:outline-accent",
    ].join(" "),
    className,
  )
  const content = (
    <>
      <span className="add-subscription-fill" aria-hidden="true" />
      <span className="add-subscription-icon" aria-hidden="true">
        {pending ? (
          <LoaderCircle size={16} className="motion-safe:animate-spin" />
        ) : (
          <span className="add-subscription-plus">
            <Plus size={16} />
          </span>
        )}
      </span>
      <span className="add-subscription-label">{pending ? "检查配置…" : "添加订阅"}</span>
    </>
  )
  if (to)
    return (
      <MotionLink to={to} className={classes} {...interaction}>
        {content}
      </MotionLink>
    )
  return (
    <motion.button
      type="button"
      {...(props as HTMLMotionProps<"button">)}
      {...interaction}
      ref={ref}
      className={classes}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
    >
      {content}
    </motion.button>
  )
})
