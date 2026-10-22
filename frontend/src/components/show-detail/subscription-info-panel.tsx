import { Pencil } from "lucide-react"
import type { ShowDetail } from "@/lib/api"
import { Button } from "@/components/ui/button"

export function SubscriptionInfoPanel({ show, onEdit }: { show: ShowDetail; onEdit: () => void }) {
  const feed = show.subscription
  return (
    <div className="detail-subscription">
      <dl>
        <div>
          <dt>来源类型</dt>
          <dd>{feed.kind === "magnet" ? "磁力合集" : feed.kind === "mikan" ? "Mikan Project" : "标准 RSS / Atom"}</dd>
        </div>
        <div>
          <dt>启用状态</dt>
          <dd>{feed.active ? "已启用" : "已停用"}</dd>
        </div>
        <div>
          <dt>季度</dt>
          <dd>{feed.season == null ? "自动识别" : feed.season === 0 ? "特别篇（第 0 季）" : `第 ${feed.season} 季`}</dd>
        </div>
        {feed.kind !== "magnet" && (
          <>
            <div>
              <dt>刷新间隔</dt>
              <dd>{feed.refresh_interval_minutes} 分钟</dd>
            </div>
            <div>
              <dt>最近检查</dt>
              <dd>{feed.last_checked_at ? new Date(feed.last_checked_at).toLocaleString("zh-CN") : "尚未检查"}</dd>
            </div>
            <div>
              <dt>连接状态</dt>
              <dd>
                {(
                  {
                    healthy: "连接正常",
                    connected: "连接正常",
                    ok: "连接正常",
                    error: "连接异常",
                    failed: "连接异常",
                    unknown: "尚未检查",
                  } as Record<string, string>
                )[feed.connection_status] ?? feed.connection_status}
              </dd>
            </div>
          </>
        )}
        <div>
          <dt>排除关键词</dt>
          <dd>{feed.excluded_keywords.length ? feed.excluded_keywords.join("、") : "未设置"}</dd>
        </div>
        {show.metadata_scraped_at && (
          <div>
            <dt>元数据更新</dt>
            <dd>{new Date(show.metadata_scraped_at).toLocaleString("zh-CN")}</dd>
          </div>
        )}
      </dl>
      {feed.kind !== "magnet" && feed.last_error && (
        <p role="alert" className="text-danger">
          {feed.last_error}
        </p>
      )}
      <Button variant="secondary" icon={Pencil} onClick={() => onEdit()}>
        编辑订阅
      </Button>
    </div>
  )
}
