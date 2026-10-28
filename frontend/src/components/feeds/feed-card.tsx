import { ContextMenu } from "radix-ui"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { MoreHorizontal, Pause, Pencil, RefreshCw, Trash2 } from "lucide-react"
import { api, type Feed, type Show } from "@/lib/api"
import { FeedClearlogo } from "@/components/feed-clearlogo"
import { Badge } from "@/components/ui/badge"
import { Button, NativeButton } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useToast } from "@/components/ui/toast"

function FeedConnectionStatus({ feed }: { feed: Feed }) {
  const status = (
    <Badge
      tone={
        feed.connection_status === "healthy" ? "success" : feed.connection_status === "error" ? "danger" : "neutral"
      }
    >
      {feed.connection_status === "healthy" ? "正常" : feed.connection_status === "error" ? "异常" : "未检查"}
    </Badge>
  )
  if (!feed.last_error) return status

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <NativeButton
          type="button"
          aria-label={`${feed.name}：连接状态，查看异常详情`}
          className="cursor-help rounded-inset focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {status}
        </NativeButton>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="start"
        className="max-w-[min(22rem,calc(100vw-2rem))] whitespace-pre-wrap break-words leading-5 [overflow-wrap:anywhere]"
      >
        {feed.last_error}
      </TooltipContent>
    </Tooltip>
  )
}

type Props = {
  feed: Feed
  clearlogo?: Show
  deleting: boolean
  stopping: boolean
  onEdit: (feed: Feed) => void
  onDelete: (feed: Feed) => void
  onStop: (feed: Feed) => void
}

export function FeedCard({ feed, clearlogo, deleting, stopping, onEdit, onDelete, onStop }: Props) {
  const client = useQueryClient()
  const toast = useToast()
  const refresh = useMutation({
    mutationFn: () => api<{ created: number; duplicates: number }>(`/feeds/${feed.id}/refresh`, { method: "POST" }),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: ["feeds"] })
      void client.invalidateQueries({ queryKey: ["dashboard"] })
      void client.invalidateQueries({ queryKey: ["shows"] })
      toast("RSS 刷新完成", { description: `新增 ${result.created} 条，忽略 ${result.duplicates} 条重复发布。` })
    },
    onError: (error) => toast("RSS 刷新失败", { description: error.message, tone: "error", duration: 5000 }),
  })
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          aria-label={`${feed.name}，右键打开订阅菜单`}
          className={[
            "feed-card flex flex-col transition-colors duration-200 hover:border-accent/35",
            "hover:bg-hover-background focus-visible:outline-2 focus-visible:outline-offset-2",
            "focus-visible:outline-accent",
          ].join(" ")}
        >
          <div className="min-w-0">
            <p className="feed-card-title" title={feed.name}>
              {feed.name}
            </p>
          </div>
          {Boolean(clearlogo) && (
            <div className="feed-card-clearlogo" aria-hidden="true">
              <FeedClearlogo show={clearlogo!} />
            </div>
          )}
          <div className="feed-card-status">
            <div className="feed-card-labels">
              <FeedConnectionStatus feed={feed} />
              <Badge>{feed.kind === "magnet" ? "磁力合集" : feed.kind}</Badge>
              {!feed.active && <Badge>已停止</Badge>}
            </div>
            <div className="feed-card-actions">
              <Button
                size="icon-sm"
                variant="secondary"
                icon={Pencil}
                disabled={deleting || stopping}
                onClick={() => onEdit(feed)}
                aria-label={`${feed.name}：编辑订阅`}
                title="编辑订阅"
              />
              {feed.kind !== "magnet" && (
                <Button
                  size="icon-sm"
                  variant="secondary"
                  icon={RefreshCw}
                  iconMotion="refresh"
                  pending={refresh.isPending}
                  disabled={!feed.active || deleting || stopping}
                  onClick={() => refresh.mutate()}
                  aria-label={`${feed.name}：${refresh.isPending ? "刷新中" : "刷新订阅"}`}
                  title={!feed.active ? "订阅已停止" : refresh.isPending ? "刷新中" : "刷新订阅"}
                />
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon-sm" variant="ghost" aria-label={`${feed.name}：更多操作`} title="更多操作">
                    <MoreHorizontal size={16} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem disabled={deleting || stopping} onSelect={() => onEdit(feed)}>
                    <Pencil size={15} />
                    编辑订阅
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={!feed.active || stopping || deleting} onSelect={() => onStop(feed)}>
                    <Pause size={15} />
                    {stopping ? "停止中…" : "停止订阅"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={deleting || stopping}
                    onSelect={() => onDelete(feed)}
                    className="text-danger"
                  >
                    <Trash2 size={15} />
                    删除订阅
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className={[
            "z-[70] min-w-36 overflow-hidden rounded-card border border-border bg-navigation-background p-1",
            "shadow-xl backdrop-blur-md",
          ].join(" ")}
        >
          <ContextMenu.Item
            disabled={deleting || stopping}
            onSelect={() => onEdit(feed)}
            className={[
              "flex cursor-default select-none items-center gap-2 rounded-inset px-3 py-2 text-sm text-ink",
              "outline-none transition-colors data-[highlighted]:bg-accent-soft data-[highlighted]:text-accent data-[disabled]:opacity-50",
            ].join(" ")}
          >
            <Pencil size={15} />
            编辑订阅
          </ContextMenu.Item>
          <ContextMenu.Item
            disabled={!feed.active || stopping || deleting}
            onSelect={() => onStop(feed)}
            className={[
              "flex cursor-default select-none items-center gap-2 rounded-inset px-3 py-2 text-sm text-ink",
              "outline-none transition-colors data-[highlighted]:bg-accent-soft data-[highlighted]:text-accent data-[disabled]:opacity-50",
            ].join(" ")}
          >
            <Pause size={15} />
            {stopping ? "停止中…" : "停止订阅"}
          </ContextMenu.Item>
          <ContextMenu.Item
            disabled={deleting || stopping}
            onSelect={() => onDelete(feed)}
            className={[
              "flex cursor-default select-none items-center gap-2 rounded-inset px-3 py-2 text-sm text-danger",
              "outline-none transition-colors data-[highlighted]:bg-danger-soft data-[disabled]:opacity-50",
            ].join(" ")}
          >
            <Trash2 size={15} />
            删除订阅
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
