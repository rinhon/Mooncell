import type { CSSProperties } from "react"
import { cn } from "@/lib/utils"

export function ShowCover({ title, className }: { title: string; className?: string }) {
  const hue = Array.from(title).reduce((hash, letter) => (hash * 31 + letter.codePointAt(0)!) % 360, 0)
  return <div className={cn("show-cover", className)} style={{ "--cover-hue": hue } as CSSProperties} aria-label={`${title}，暂无封面`}>
    <span className="show-cover-initial" aria-hidden="true">{Array.from(title.trim())[0] ?? "番"}</span>
    <span className="show-cover-title" aria-hidden="true">{title}</span>
  </div>
}
