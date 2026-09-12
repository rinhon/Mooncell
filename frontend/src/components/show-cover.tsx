import { Clapperboard } from "lucide-react"
import { cn } from "@/lib/utils"

export function ShowCover({ title, accent, className }: { title: string; accent: string; className?: string }) {
  return <div className={cn("relative overflow-hidden bg-gradient-to-br", accent, className)}><div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_20%,rgba(255,255,255,.7),transparent_30%)]"/><Clapperboard className="absolute right-3 top-3 text-zinc-900/20" size={22}/><p className="absolute bottom-3 left-3 right-3 text-balance text-lg font-bold leading-tight tracking-tight text-zinc-900/80">{title}</p></div>
}
