import { Link } from "react-router-dom"
import { ChevronRight } from "lucide-react"
import type { DownloadTask, Show } from "@/lib/api"
import { ModuleError, ModuleSkeleton } from "./module-state"
import type { DashboardSummary, ModuleQuery, RecentRelease } from "./types"

const statusLabels: Record<string, string> = {
  parsed: "已解析",
  approved: "已批准",
  needs_review: "待审核",
  ignored: "已忽略",
  superseded: "已被新版取代",
  failed: "解析失败",
}

function releaseHref(item: RecentRelease, shows: Show[], tasks: DownloadTask[]) {
  // 下载任务 id 与 FeedItem id 一致，可建立确切关联；同名多季则交给搜索页选择。
  const source = tasks.find((task) => task.id === item.id)?.source_id
  if (source) return `/shows/${source}`
  const title = item.parsed?.title?.trim()
  const matches = title
    ? shows.filter((show) => show.name.trim() === title || show.metadata_title?.trim() === title)
    : []
  if (matches.length === 1) return `/shows/${matches[0].id}`
  return `/shows?q=${encodeURIComponent(title || item.title)}`
}

function releaseTime(value: string | null) {
  if (!value) return "发布时间未知"
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? "发布时间未知"
    : date.toLocaleString("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
}

export function RecentReleases({
  query,
  shows,
  tasks,
}: {
  query: ModuleQuery<DashboardSummary>
  shows: Show[]
  tasks: DownloadTask[]
}) {
  const items = query.data?.recent_items ?? []
  return (
    <section className="dashboard-panel dashboard-releases" aria-labelledby="dashboard-releases-title">
      <header className="dashboard-panel-heading">
        <div>
          <h2 id="dashboard-releases-title">最新发布</h2>
          <p>最近发现的 RSS 发布</p>
        </div>
        <Link to="/shows">番剧库</Link>
      </header>
      {query.isError && (
        <ModuleError message={`最新发布读取失败：${query.error?.message ?? "请稍后重试"}`} onRetry={query.refetch} />
      )}
      {!query.data && query.isPending && <ModuleSkeleton label="正在加载最新发布" rows={3} />}
      {query.data &&
        (items.length ? (
          <ul className="dashboard-release-list">
            {items.map((item) => (
              <li key={item.id}>
                <Link
                  to={releaseHref(item, shows, tasks)}
                  className="dashboard-release-item"
                  aria-label={`查看发布：${item.title}`}
                >
                  <span className="dashboard-release-copy">
                    <strong title={item.title}>{item.title}</strong>
                    <span>
                      <time dateTime={item.publishedAt || undefined}>{releaseTime(item.publishedAt)}</time>
                      {item.parsed?.resolution && <> · {item.parsed.resolution}</>}
                      {item.parsed?.release_group && <> · {item.parsed.release_group}</>}
                    </span>
                  </span>
                  <span className="dashboard-release-status" data-review={item.status === "needs_review"}>
                    {statusLabels[item.status] ?? "已发现"}
                  </span>
                  <ChevronRight size={15} className="text-muted" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <div className="dashboard-module-empty">
            <p>还没有发现新发布</p>
            <Link to="/feeds">管理订阅来源</Link>
          </div>
        ))}
    </section>
  )
}
