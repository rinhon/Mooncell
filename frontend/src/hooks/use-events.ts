import { useEffect, useRef } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useToast } from "@/components/ui/toast"

/** 订阅后端领域事件，并让 TanStack Query 重新获取受影响的服务端状态。 */
export function useEvents(enabled: boolean) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const startedAt = useRef(Date.now())
  const notified = useRef(new Set<number>())
  useEffect(() => {
    if (!enabled) return
    const stream = new EventSource("/api/v1/events/stream", { withCredentials: true })
    // SSE 只承载“状态已变化”的通知，页面数据仍从普通 API 获取，避免双数据源。
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] })
      void queryClient.invalidateQueries({ queryKey: ["feeds"] })
      void queryClient.invalidateQueries({ queryKey: ["shows"] })
      void queryClient.invalidateQueries({ queryKey: ["reviews"] })
      void queryClient.invalidateQueries({ queryKey: ["downloads"] })
    }
    const notifyFeedSetup = (event: MessageEvent<string>) => {
      refresh()
      const data = JSON.parse(event.data) as { id: number; message: string; type: string; occurredAt: string }
      // SSE 重连会补发事件；首次加载时不弹旧通知，同一事件只提示一次。
      const timestamp = /(?:Z|[+-]\d{2}:\d{2})$/.test(data.occurredAt) ? data.occurredAt : `${data.occurredAt}Z`
      if (Date.parse(timestamp) < startedAt.current || notified.current.has(data.id)) return
      notified.current.add(data.id)
      toast(data.message, { tone: data.type.endsWith(".failed") ? "error" : data.type.endsWith(".partial") ? "warning" : "success" })
    }
    stream.addEventListener("feed.setup.completed", notifyFeedSetup)
    stream.addEventListener("feed.setup.partial", notifyFeedSetup)
    stream.addEventListener("feed.setup.failed", notifyFeedSetup)
    stream.addEventListener("feed.refresh.completed", refresh)
    stream.addEventListener("feed.updated", refresh)
    stream.addEventListener("feed.refresh.failed", refresh)
    stream.addEventListener("item.discovered", refresh)
    stream.addEventListener("review.approved", refresh)
    stream.addEventListener("review.ignored", refresh)
    stream.addEventListener("review.reparsed", refresh)
    return () => stream.close()
  }, [enabled, queryClient, toast])
}
