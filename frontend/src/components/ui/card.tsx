import * as React from "react"
import { cn } from "@/lib/utils"

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) { return <div data-slot="card" className={cn("rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-[0_1px_2px_rgba(0,0,0,.03)]", className)} {...props} /> }
export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) { return <div data-slot="card-header" className={cn("flex items-start justify-between gap-4 p-5 pb-3", className)} {...props} /> }
export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) { return <h3 className={cn("font-semibold tracking-tight text-[var(--ink)]", className)} {...props} /> }
export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) { return <p className={cn("mt-1 text-sm leading-6 text-[var(--muted)]", className)} {...props} /> }
export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) { return <div data-slot="card-content" className={cn("p-5 pt-2", className)} {...props} /> }
