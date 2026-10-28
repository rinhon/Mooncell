import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { RadioTower } from "lucide-react"
import { api, type Feed, type FeedBatchStopResult, type Show } from "@/lib/api"
import { AddSubscriptionDialog } from "@/components/feeds/add-subscription-dialog"
import { BatchStopMenu } from "@/components/feeds/batch-stop-menu"
import { FeedCard } from "@/components/feeds/feed-card"
import { DeleteFeedDialog } from "@/components/feeds/delete-feed-dialog"
import { EditSubscriptionDialog } from "@/components/edit-subscription-dialog"
import { FeedsHeading, FeedsLoading, FeedsSection } from "@/components/feeds-loading"
import { Button } from "@/components/ui/button"
import { Masonry } from "@/components/ui/masonry"
import { useToast } from "@/components/ui/toast"

/** 订阅来源的列表、刷新、停止和删除界面。 */
export function FeedsPage() {
  const client = useQueryClient()
  const toast = useToast()
  const [editing, setEditing] = useState<Feed | null>(null)
  const [deleting, setDeleting] = useState<Feed | null>(null)
  const feeds = useQuery({ queryKey: ["feeds"], queryFn: () => api<Feed[]>("/feeds") })
  const shows = useQuery({ queryKey: ["shows"], queryFn: () => api<Show[]>("/shows") })
  const clearlogos = new Map(shows.data?.filter((show) => show.clearlogo_ready).map((show) => [show.id, show]))
  function refreshStoppedFeeds(items: Feed[]) {
    const updated = new Map(items.map((feed) => [feed.id, feed]))
    client.setQueryData<Feed[]>(["feeds"], (previous) => previous?.map((feed) => updated.get(feed.id) ?? feed))
    for (const key of ["notifications", "feeds", "dashboard", "shows", "downloads", "reviews"]) {
      void client.invalidateQueries({ queryKey: [key] })
    }
  }
  const stop = useMutation({
    mutationFn: (id: number) => api<Feed>(`/feeds/${id}/stop`, { method: "POST" }),
    onSuccess: (feed) => {
      refreshStoppedFeeds([feed])
      toast("订阅已停止", { description: feed.name })
    },
    onError: (error) => {
      void client.invalidateQueries({ queryKey: ["feeds"] })
      toast("停止订阅失败", { description: error.message, tone: "error" })
    },
  })
  const batchStop = useMutation({
    mutationFn: (sourceIds: number[]) =>
      api<FeedBatchStopResult>("/feeds/batch-stop", {
        method: "POST",
        body: JSON.stringify({ source_ids: sourceIds }),
      }),
    onSuccess: (result) => {
      refreshStoppedFeeds(result.items)
      toast(result.stopped_count ? `已停止 ${result.stopped_count} 个订阅` : "所选订阅均已停止", {
        description: result.already_stopped_count ? `${result.already_stopped_count} 个订阅此前已停止。` : undefined,
      })
    },
    onError: (error) => {
      void client.invalidateQueries({ queryKey: ["feeds"] })
      toast("批量停止失败", { description: error.message, tone: "error" })
    },
  })
  const stopping = stop.isPending || batchStop.isPending
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
      <FeedsHeading
        action={
          <div className="flex flex-wrap items-center gap-3">
            <AddSubscriptionDialog />
            <BatchStopMenu
              feeds={feeds.data ?? []}
              pending={batchStop.isPending}
              disabled={remove.isPending || stop.isPending || Boolean(editing || deleting)}
              onStop={(ids) => batchStop.mutateAsync(ids)}
            />
          </div>
        }
      />
      <FeedsSection count={feeds.data?.length ?? 0}>
        {feeds.isError && feeds.data !== undefined && (
          <div role="alert" className="px-5 py-3 text-sm text-danger">
            订阅刷新失败，正在显示上次读取的数据：{feeds.error.message}
            <Button
              variant="secondary"
              size="sm"
              className="ml-3"
              disabled={feeds.isFetching}
              onClick={() => void feeds.refetch()}
            >
              重试
            </Button>
          </div>
        )}
        {feeds.isError && feeds.data === undefined ? (
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
          <Masonry
            className="feed-list"
            columns="auto-fit"
            columnWidth={400}
            aria-label="订阅与合集"
            hoverEffect="none"
          >
            {feeds.data.map((feed) => (
              <FeedCard
                key={feed.id}
                feed={feed}
                clearlogo={clearlogos.get(feed.id)}
                deleting={remove.isPending || stopping}
                stopping={
                  (stop.isPending && stop.variables === feed.id) ||
                  (batchStop.isPending && batchStop.variables.includes(feed.id))
                }
                onEdit={setEditing}
                onDelete={setDeleting}
                onStop={(selected) => {
                  if (!remove.isPending && !stopping && selected.active) stop.mutate(selected.id)
                }}
              />
            ))}
          </Masonry>
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
