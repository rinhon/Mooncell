import { forwardRef, type ButtonHTMLAttributes } from "react"
import { Plus } from "lucide-react"
import { Link } from "react-router-dom"
import { cn } from "@/lib/utils"
import "./add-subscription-button.css"

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { to?: string }

export const AddSubscriptionButton = forwardRef<HTMLButtonElement, Props>(
  function AddSubscriptionButton({ to, className, ...props }, ref) {
    const classes = cn("add-subscription-button relative isolate inline-flex shrink-0 items-center justify-center overflow-hidden whitespace-nowrap rounded-[2px] border border-[var(--accent)] bg-transparent text-sm font-medium text-[var(--accent)] disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]", className)
    const content = <><span className="add-subscription-icon" aria-hidden="true"><Plus size={16}/></span><span className="add-subscription-label">添加订阅</span></>
    if (to) return <Link to={to} className={classes}>{content}</Link>
    return <button type="button" {...props} ref={ref} className={classes}>{content}</button>
  },
)
