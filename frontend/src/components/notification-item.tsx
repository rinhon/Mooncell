import { Check, CheckCircle2, CircleAlert, Clock3, LoaderCircle, XCircle } from "lucide-react"
import { Link } from "react-router-dom"
import { ReviewLink } from "@/components/review-link"
import type { BackgroundOperation } from "@/lib/api"

const labels = {
  feed_scrape: "订阅刮削",
  metadata_refresh: "元数据更新",
  artwork_scrape: "重新刮削",
  library_migration: "文件整理",
  download_added: "新增下载",
  review_required: "任务审核",
}
const states = {
  queued: "排队中",
  running: "进行中",
  blocked: "需要处理",
  completed: "已完成",
  partial: "部分完成",
  failed: "失败",
  cancelled: "已取消",
}

export function NotificationItem({
  item,
  onRead,
  onNavigate,
  pending,
}: {
  item: BackgroundOperation
  onRead: (item: BackgroundOperation) => void
  onNavigate: () => void
  pending: boolean
}) {
  const Icon =
    item.status === "completed"
      ? CheckCircle2
      : item.status === "failed"
        ? XCircle
        : ["blocked", "partial"].includes(item.status)
          ? CircleAlert
          : item.status === "running"
            ? LoaderCircle
            : Clock3
  const href = `/shows/${item.source_id}`
  const state =
    item.kind === "download_added" && item.status === "completed"
      ? "已添加"
      : item.kind === "review_required" && item.status === "blocked"
        ? "待审核"
        : item.kind === "review_required" && item.status === "completed"
          ? "已批准"
          : states[item.status]
  function follow() {
    if (item.unread) onRead(item)
    onNavigate()
  }
  return (
    <li className={`notification-item ${item.unread ? "is-unread" : ""}`}>
      <div className="notification-item-heading">
        <span className="notification-source">{item.source_name}</span>
        {item.unread && <span className="notification-dot" aria-label="未读" />}
      </div>
      <div className="notification-meta">
        <span>{labels[item.kind]}</span>
        <span className={`notification-status status-${item.status}`}>
          <Icon size={13} aria-hidden="true" />
          {state}
        </span>
      </div>
      <p className="notification-result">{item.summary}</p>
      {item.total_count > 0 && !["completed", "cancelled"].includes(item.status) && (
        <progress
          className="notification-progress"
          aria-label="已同步的下载任务"
          value={item.completed_count}
          max={item.total_count}
        />
      )}
      {item.error_summary && <p className="notification-error">{item.error_summary}</p>}
      <time className="notification-time" dateTime={item.updated_at}>
        {new Date(item.updated_at).toLocaleString("zh-CN", {
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })}
      </time>
      <div className="notification-item-actions">
        {item.source_id && item.kind === "download_added" && (
          <Link to={`/downloads?source_id=${item.source_id}`} onClick={follow}>
            查看下载
          </Link>
        )}
        {item.source_id && item.kind === "review_required" && item.status === "blocked" && (
          <ReviewLink to="/review" onClick={follow}>
            前往审核
          </ReviewLink>
        )}
        {item.source_id ? (
          <Link to={href} onClick={follow}>
            查看番剧
          </Link>
        ) : (
          <span className="notification-time">关联订阅已删除</span>
        )}
        <Link to={`/logs?operation_id=${encodeURIComponent(item.id)}`} onClick={follow}>
          相关日志
        </Link>
        {item.unread && (
          <button
            type="button"
            onClick={() => onRead(item)}
            disabled={pending}
            aria-label={`将${item.source_name}的${labels[item.kind]}标为已读`}
          >
            <Check size={13} />
            已读
          </button>
        )}
      </div>
    </li>
  )
}
