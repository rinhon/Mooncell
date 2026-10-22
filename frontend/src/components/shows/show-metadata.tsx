import type { Show } from "@/lib/api"
import { Badge } from "@/components/ui/badge"

export function TmdbLink({ show }: { show: Show }) {
  const label = <Badge>TMDB #{show.tmdb_id}</Badge>
  const href = show.tmdb_url
  if (!href || !/^https?:\/\//i.test(href)) return label
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`在新标签页打开 ${show.name} 的 TMDB 页面`}
      data-cursor-label="跳转"
      className="rounded-sm transition-opacity hover:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      {label}
    </a>
  )
}

export function DiscoveredItemsButton({ show, onClick }: { show: Show; onClick: () => void }) {
  if (show.discovered_items === 0) return <span className="font-semibold">0 条</span>
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "rounded-sm font-semibold text-ink underline decoration-current/30 underline-offset-4 transition",
        "hover:decoration-current focus-visible:outline-2 focus-visible:outline-offset-2",
      ].join(" ")}
      aria-label={`查看 ${show.name} 的 ${show.discovered_items} 条 RSS 标题`}
    >
      {show.discovered_items} 条
    </button>
  )
}
