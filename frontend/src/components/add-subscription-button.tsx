import { forwardRef, type ButtonHTMLAttributes } from "react"
import { Plus } from "lucide-react"
import { Link } from "react-router-dom"
import { cn } from "@/lib/utils"

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { to?: string }

export const AddSubscriptionButton = forwardRef<HTMLButtonElement, Props>(
  function AddSubscriptionButton({ to, className, ...props }, ref) {
    const content = <><span className="subscription-action-icon"><Plus size={16} aria-hidden="true"/></span><span className="subscription-action-label">添加订阅</span></>
    const classes = cn("subscription-action", className)
    if (to) return <Link to={to} className={classes}>{content}</Link>
    return <button type="button" {...props} ref={ref} className={classes}>{content}</button>
  },
)
