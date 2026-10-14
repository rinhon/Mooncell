import { useEffect } from "react"
import { useQueryClient } from "@tanstack/react-query"

/** 订阅后端领域事件，并让 TanStack Query 重新获取受影响的服务端状态。 */
export function useEvents(enabled: boolean) {
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!enabled) return
    const stream = new EventSource("/api/v1/events/stream", { withCredentials: true })
    // SSE 只承载“状态已变化”的通知，页面数据仍从普通 API 获取，避免双数据源。
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] })
      void queryClient.invalidateQueries({ queryKey: ["feeds"] })
      void queryClient.invalidateQueries({ queryKey: ["reviews"] })
      void queryClient.invalidateQueries({ queryKey: ["downloads"] })
    }
    stream.addEventListener("feed.refresh.completed", refresh)
    stream.addEventListener("feed.updated", refresh)
    stream.addEventListener("feed.refresh.failed", refresh)
    stream.addEventListener("item.discovered", refresh)
    stream.addEventListener("review.approved", refresh)
    stream.addEventListener("review.ignored", refresh)
    stream.addEventListener("review.reparsed", refresh)
    return () => stream.close()
  }, [enabled, queryClient])
}
