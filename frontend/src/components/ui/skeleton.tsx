import type { HTMLAttributes } from "react"
import { cn } from "@/lib/utils"

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" className={cn("skeleton rounded-[2px]", className)} {...props}/>
}
