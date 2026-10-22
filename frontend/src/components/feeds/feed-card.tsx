import { ContextMenu } from "radix-ui"
import { MoreHorizontal, Pencil, RefreshCw, Trash2 } from "lucide-react"
import type { Feed, Show } from "@/lib/api"
import { FeedClearlogo } from "@/components/feed-clearlogo"
import { Badge } from "@/components/ui/badge"
import { Button, NativeButton } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

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
  refreshing: boolean
  refreshPending: boolean
  deleting: boolean
  onEdit: (feed: Feed) => void
  onDelete: (feed: Feed) => void
  onRefresh: (id: number) => void
}

export function FeedCard({
  feed,
  clearlogo,
  refreshing,
  refreshPending,
  deleting,
  onEdit,
  onDelete,
  onRefresh,
}: Props) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          aria-label={`${feed.name}，右键打开订阅菜单`}
          className={[
            "feed-card flex flex-col gap-4 p-5 transition-colors duration-200 hover:border-accent/35",
            "hover:bg-hover-background focus-visible:outline-2 focus-visible:outline-offset-2",
            "focus-visible:outline-accent",
          ].join(" ")}
        >
          <div className="min-w-0 flex-1">
            <p className="break-words text-base font-semibold leading-6">{feed.name}</p>
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
              {!feed.active && <Badge>已停用</Badge>}
            </div>
            <div className="feed-card-actions">
              <Button
                size="sm"
                variant="secondary"
                icon={Pencil}
                onClick={() => onEdit(feed)}
                aria-label={`${feed.name}：编辑订阅`}
              >
                编辑
              </Button>
              {feed.kind !== "magnet" && (
                <Button
                  size="sm"
                  variant="secondary"
                  icon={RefreshCw}
                  iconMotion="refresh"
                  pending={refreshing}
                  pendingLabel="刷新中"
                  onClick={() => onRefresh(feed.id)}
                  disabled={refreshPending}
                  aria-label={`${feed.name}：刷新订阅`}
                >
                  刷新
                </Button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon-sm" variant="ghost" aria-label={`${feed.name}：更多操作`}>
                    <MoreHorizontal size={16} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => onEdit(feed)}>
                    <Pencil size={15} />
                    编辑订阅
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={deleting} onSelect={() => onDelete(feed)} className="text-danger">
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
            onSelect={() => onEdit(feed)}
            className={[
              "flex cursor-default select-none items-center gap-2 rounded-inset px-3 py-2 text-sm text-ink",
              "outline-none transition-colors data-[highlighted]:bg-accent-soft data-[highlighted]:text-accent",
            ].join(" ")}
          >
            <Pencil size={15} />
            编辑订阅
          </ContextMenu.Item>
          <ContextMenu.Item
            disabled={deleting}
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
