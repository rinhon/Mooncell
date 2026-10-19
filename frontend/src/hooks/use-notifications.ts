import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api, type BackgroundOperation, type NotificationPage, type NotificationSummary } from "@/lib/api"

export function useNotifications(open: boolean) {
  const client = useQueryClient()
  const summary = useQuery({
    queryKey: ["notifications", "summary"],
    queryFn: ({ signal }) => api<NotificationSummary>("/notifications/summary", { signal }),
    refetchOnWindowFocus: true,
  })
  const list = useInfiniteQuery({
    queryKey: ["notifications", "list"], initialPageParam: "",
    queryFn: ({ pageParam, signal }) => api<NotificationPage>(`/notifications?limit=20${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`, { signal }),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled: open, refetchOnWindowFocus: true,
  })
  const refresh = () => client.invalidateQueries({ queryKey: ["notifications"] })
  const read = useMutation({
    mutationFn: (item: BackgroundOperation) => api(`/notifications/${item.id}/read`, {
      method: "PATCH", body: JSON.stringify({ attention_revision: item.attention_revision }),
    }),
    onSuccess: refresh,
  })
  const readAll = useMutation({
    mutationFn: (cutoff: string) => api("/notifications/read-all", { method: "POST", body: JSON.stringify({ cutoff }) }),
    onSuccess: refresh,
  })
  const byId = new Map<string, BackgroundOperation>()
  for (const page of list.data?.pages ?? []) {
    for (const item of page.items) {
      const existing = byId.get(item.id)
      if (!existing || item.revision > existing.revision) byId.set(item.id, item)
    }
  }
  // 第一页的活动快照优先，进度变化后旧分页中的相同 ID 不会回退。
  for (const item of list.data?.pages[0]?.active_items ?? []) byId.set(item.id, item)
  const items = [...byId.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id))
  return { summary, list, read, readAll, items, refresh }
}
