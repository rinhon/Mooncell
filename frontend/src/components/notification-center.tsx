import { useEffect, useRef, useState } from "react"
import { Bell, CheckCheck, RefreshCw, X } from "lucide-react"
import { GradualBlur } from "@/components/ui/gradual-blur"
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { NotificationItem } from "@/components/notification-item"
import { useNotifications } from "@/hooks/use-notifications"

export function NotificationCenter() {
  const [open, setOpen] = useState(false)
  const opener = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const show = () => {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setOpen(true)
    }
    window.addEventListener("mooncell:open-notifications", show)
    return () => window.removeEventListener("mooncell:open-notifications", show)
  }, [])
  const { summary, list, read, readAll, items, refresh } = useNotifications(open)
  const count = summary.data?.unread_count ?? list.data?.pages[0]?.unread_count ?? 0
  const active = items.filter((item) => ["queued", "running", "blocked"].includes(item.status))
  const recent = items.filter((item) => !["queued", "running", "blocked"].includes(item.status))
  const render = (rows: typeof items) => (
    <ul className="notification-list">
      {rows.map((item) => (
        <NotificationItem
          key={item.id}
          item={item}
          onRead={(value) => read.mutate(value)}
          onNavigate={() => setOpen(false)}
          pending={read.isPending}
        />
      ))}
    </ul>
  )
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="utility-link notification-trigger"
          type="button"
          aria-label={summary.isError ? "提醒，未读数加载失败" : `提醒，${count} 条未读`}
          title="提醒中心"
        >
          <Bell size={18} strokeWidth={1.5} />
          {count > 0 && (
            <span className="notification-badge" aria-hidden="true">
              {count > 99 ? "99+" : count}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        aria-labelledby="notification-title"
        aria-describedby="notification-description"
        onCloseAutoFocus={(event) => {
          const target = opener.current
          opener.current = null
          if (target?.isConnected) {
            event.preventDefault()
            target.focus()
          }
        }}
      >
        <div className="notification-header">
          <div>
            <h2 id="notification-title">提醒中心</h2>
            <p id="notification-description">后台操作进度与结果</p>
          </div>
          <PopoverClose className="notification-close" aria-label="关闭提醒中心">
            <X size={17} />
          </PopoverClose>
        </div>
        <div className="notification-toolbar">
          <span aria-live="polite">
            {count} 条未读 · {summary.data?.active_count ?? active.length} 项进行中
          </span>
          <button
            type="button"
            disabled={readAll.isPending || !count || !list.data}
            onClick={() => {
              const cutoff = list.data?.pages[0]?.cutoff
              if (cutoff) readAll.mutate(cutoff)
            }}
          >
            <CheckCheck size={14} />
            全部已读
          </button>
        </div>
        {(read.isError || readAll.isError) && (
          <p role="alert" className="notification-feedback">
            标记已读失败，请重试。
          </p>
        )}
        <div className="relative overflow-hidden">
          <div className="notification-scroll">
            {list.isPending && (
              <p className="notification-empty" role="status">
                正在读取提醒…
              </p>
            )}
            {(list.isError || summary.isError) && (
              <div role="alert" className="notification-empty">
                提醒加载失败
                <button type="button" onClick={() => void refresh()}>
                  <RefreshCw size={14} />
                  重试
                </button>
              </div>
            )}
            {!!active.length && (
              <section aria-label="进行中">
                <h3>进行中</h3>
                {render(active)}
              </section>
            )}
            {!!recent.length && (
              <section aria-label="最近提醒">
                <h3>最近提醒</h3>
                {render(recent)}
              </section>
            )}
            {list.isSuccess && !items.length && (
              <div className="notification-empty">
                <Bell size={26} />
                <p>暂无提醒</p>
                <span>后台操作的进度和结果会保存在这里。</span>
              </div>
            )}
            {list.hasNextPage && (
              <button
                className="notification-load-more"
                type="button"
                disabled={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
              >
                {list.isFetchingNextPage ? "加载中…" : "加载更多"}
              </button>
            )}
          </div>
          {items.length > 3 && (
            <GradualBlur
              position="bottom"
              height="28px"
              strength={1.5}
              divCount={3}
              zIndex={2}
              tint="var(--shell-bottom-tint)"
            />
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
