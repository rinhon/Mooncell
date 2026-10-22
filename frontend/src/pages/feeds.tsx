import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { RadioTower } from "lucide-react"
import { api, type Feed, type Show } from "@/lib/api"
import { AddSubscriptionDialog } from "@/components/feeds/add-subscription-dialog"
import { FeedCard } from "@/components/feeds/feed-card"
import { DeleteFeedDialog } from "@/components/feeds/delete-feed-dialog"
import { EditSubscriptionDialog } from "@/components/edit-subscription-dialog"
import { FeedsHeading, FeedsLoading, FeedsSection } from "@/components/feeds-loading"
import { Button } from "@/components/ui/button"
import { BlurFade } from "@/components/ui/blur-fade"
import { useToast } from "@/components/ui/toast"

/** RSS 源的列表、手动刷新和删除界面。 */
export function FeedsPage() {
  const client = useQueryClient()
  const toast = useToast()
  const [editing, setEditing] = useState<Feed | null>(null)
  const [deleting, setDeleting] = useState<Feed | null>(null)
  const feeds = useQuery({ queryKey: ["feeds"], queryFn: () => api<Feed[]>("/feeds") })
  const shows = useQuery({ queryKey: ["shows"], queryFn: () => api<Show[]>("/shows") })
  const clearlogos = new Map(shows.data?.filter((show) => show.clearlogo_ready).map((show) => [show.id, show]))
  const refresh = useMutation({
    mutationFn: (id: number) =>
      api<{ created: number; duplicates: number }>(`/feeds/${id}/refresh`, { method: "POST" }),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: ["feeds"] })
      void client.invalidateQueries({ queryKey: ["dashboard"] })
      void client.invalidateQueries({ queryKey: ["shows"] })
      toast("RSS 刷新完成", { description: `新增 ${result.created} 条，忽略 ${result.duplicates} 条重复发布。` })
    },
    onError: (error) => toast("RSS 刷新失败", { description: error.message, tone: "error" }),
  })
  const remove = useMutation({
    mutationFn: (id: number) => api(`/feeds/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["notifications"] })
      void client.invalidateQueries({ queryKey: ["feeds"] })
      void client.invalidateQueries({ queryKey: ["dashboard"] })
      void client.invalidateQueries({ queryKey: ["shows"] })
      toast(deleting?.kind === "magnet" ? "磁力合集已删除" : "RSS 订阅已删除")
      setDeleting(null)
    },
    onError: (error) => toast("删除订阅失败", { description: error.message, tone: "error" }),
  })

  if (feeds.isPending || (!feeds.isError && Boolean(feeds.data?.length) && shows.isPending)) {
    return <FeedsLoading count={feeds.data?.length} />
  }
  return (
    <>
      <FeedsHeading action={<AddSubscriptionDialog />} />
      <FeedsSection count={feeds.data?.length ?? 0}>
        {feeds.isError ? (
          <div role="alert" className="p-5 text-sm text-danger">
            订阅读取失败：{feeds.error.message}
            <Button variant="secondary" size="sm" className="ml-3" onClick={() => void feeds.refetch()}>
              重试
            </Button>
          </div>
        ) : !feeds.data?.length ? (
          <div className="grid min-h-64 place-items-center p-5">
            <div className="text-center">
              <RadioTower className="mx-auto text-muted" size={30} />
              <p className="mt-3 text-sm font-medium">还没有 RSS 订阅</p>
              <p className="mt-1 text-[13px] text-muted">先从蜜柑计划复制一个番剧 RSS 地址。</p>
            </div>
          </div>
        ) : (
          <div className="feed-list">
            {feeds.data.map((feed, index) => (
              <BlurFade
                key={feed.id}
                className="feed-card-reveal min-w-0"
                delay={Math.min(index, 6) * 0.06}
                offset={8}
                inView
                inViewMargin="0px"
              >
                <FeedCard
                  feed={feed}
                  clearlogo={clearlogos.get(feed.id)}
                  refreshing={refresh.isPending && refresh.variables === feed.id}
                  refreshPending={refresh.isPending}
                  deleting={remove.isPending}
                  onEdit={setEditing}
                  onDelete={setDeleting}
                  onRefresh={(id) => refresh.mutate(id)}
                />
              </BlurFade>
            ))}
          </div>
        )}
      </FeedsSection>
      {editing && <EditSubscriptionDialog key={editing.id} feed={editing} onClose={() => setEditing(null)} />}
      <DeleteFeedDialog
        feed={deleting}
        pending={remove.isPending}
        onClose={() => setDeleting(null)}
        onConfirm={(id) => remove.mutate(id)}
      />
    </>
  )
}
