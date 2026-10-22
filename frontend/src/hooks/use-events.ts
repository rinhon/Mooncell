import { useEffect } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { NotificationSummary } from "@/lib/api"

/** SSE 仅提示重新查询；历史、未读和进度始终以数据库查询为准。 */
export function useEvents(enabled: boolean) {
  const client = useQueryClient()
  useEffect(() => {
    if (!enabled) {
      void client.cancelQueries({ queryKey: ["notifications"] })
      client.removeQueries({ queryKey: ["notifications"] })
      return
    }
    let connected = false
    const stream = new EventSource("/api/v1/events/stream", { withCredentials: true })
    const notifications = () => { void client.invalidateQueries({ queryKey: ["notifications"] }) }
    const refresh = () => {
      for (const key of ["dashboard", "feeds", "shows", "reviews", "downloads"]) {
        void client.invalidateQueries({ queryKey: [key] })
      }
    }
    stream.onopen = () => { connected = true; notifications(); refresh() }
    stream.onerror = () => { connected = false; notifications() }
    stream.addEventListener("notification.changed", () => { notifications(); refresh() })
    stream.addEventListener("library.scan.changed", refresh)
    stream.addEventListener("download.episode.renamed", refresh)
    for (const name of ["feed.setup.completed", "feed.setup.partial", "feed.setup.failed", "feed.updated", "feed.refresh.completed", "feed.refresh.failed", "item.discovered", "review.approved", "review.ignored", "review.reparsed", "download.library.changed"]) {
      stream.addEventListener(name, refresh)
    }
    const focus = () => { notifications(); refresh() }
    window.addEventListener("focus", focus)
    const interval = window.setInterval(() => {
      // 连创建和完成事件都漏收时也能自愈；关闭面板后只会补查活跃的摘要查询。
      const previous = client.getQueryData<NotificationSummary>(["notifications", "summary"])
      notifications()
      if (!connected || previous?.active_count) refresh()
    }, 15000)
    return () => {
      stream.close()
      window.clearInterval(interval)
      window.removeEventListener("focus", focus)
      void client.cancelQueries({ queryKey: ["notifications"] })
      client.removeQueries({ queryKey: ["notifications"] })
    }
  }, [enabled, client])
}
