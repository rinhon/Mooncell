import * as React from "react"
import { cn } from "@/lib/utils"

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) { return <div data-slot="card" className={cn("rounded-sm border border-[var(--border)] bg-[rgba(22,27,24,.42)] backdrop-blur-[8px]", className)} {...props} /> }
export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) { return <div data-slot="card-header" className={cn("flex items-start justify-between gap-4 border-b border-[var(--border-soft)] px-5 pb-3 pt-[18px]", className)} {...props} /> }
export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) { return <h3 className={cn("font-semibold tracking-tight text-[var(--ink)]", className)} {...props} /> }
export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) { return <p className={cn("mt-1 text-sm leading-6 text-[var(--muted)]", className)} {...props} /> }
export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) { return <div data-slot="card-content" className={cn("px-5 py-[18px]", className)} {...props} /> }
