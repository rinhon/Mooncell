import { Link } from "react-router-dom"
import { HardDriveDownload } from "lucide-react"
import type { DownloadCenter } from "@/lib/api"
import { Progress } from "@/components/ui/progress"
import { ModuleError, ModuleSkeleton } from "./module-state"
import { formatSpeed, type ModuleQuery } from "./types"

export function ActiveDownloads({ query }: { query: ModuleQuery<DownloadCenter> }) {
  const data = query.data
  const tasks = (data?.tasks ?? [])
    .filter((task) => task.status === "downloading")
    .sort((a, b) => b.download_speed - a.download_speed || b.id - a.id)
  return (
    <section className="dashboard-panel" aria-labelledby="dashboard-download-title">
      <header className="dashboard-panel-heading">
        <div>
          <h2 id="dashboard-download-title">正在下载</h2>
          <p>{data ? `${formatSpeed(data.download_speed)} · ${tasks.length} 个任务` : "连接下载器，读取实时进度"}</p>
        </div>
        <Link to="/downloads">全部任务</Link>
      </header>
      {query.isError && (
        <ModuleError message={`下载任务读取失败：${query.error?.message ?? "请稍后重试"}`} onRetry={query.refetch} />
      )}
      {!data && query.isPending && <ModuleSkeleton label="正在加载下载任务" />}
      {data?.error && (
        <p className="dashboard-service-warning" role="status">
          下载器暂时无法同步：{data.error}
        </p>
      )}
      {data &&
        (tasks.length ? (
          <ul className="dashboard-download-list">
            {tasks.slice(0, 3).map((task) => {
              const progress = Math.min(100, Math.max(0, task.progress))
              return (
                <li key={task.id}>
                  <Link
                    to={`/downloads?source_id=${task.source_id}`}
                    className="dashboard-download-item"
                    aria-label={`${task.source_name}，下载进度 ${progress.toFixed(0)}%，查看下载`}
                  >
                    <div className="dashboard-download-copy">
                      <strong title={task.title}>{task.source_name || task.title}</strong>
                      <span>{formatSpeed(task.download_speed)}</span>
                    </div>
                    <p className="dashboard-download-title" title={task.title}>
                      {task.title}
                    </p>
                    <div className="dashboard-download-progress">
                      <Progress value={progress} aria-label={`${task.source_name} 下载进度`} />
                      <span>{progress.toFixed(0)}%</span>
                    </div>
                  </Link>
                </li>
              )
            })}
          </ul>
        ) : (
          <div className="dashboard-module-empty">
            <HardDriveDownload size={28} aria-hidden="true" />
            <p>
              {!data.downloader_configured
                ? "尚未配置下载器"
                : !data.downloader_online
                  ? "下载器当前离线"
                  : "当前没有正在下载的任务"}
            </p>
            <Link to={data.downloader_configured ? "/downloads" : "/settings"}>
              {data.downloader_configured ? "查看全部下载" : "前往设置下载器"}
            </Link>
          </div>
        ))}
      {tasks.length > 0 && <p className="dashboard-panel-footnote">显示速度最高的前 3 项 · 页面可见时每 5 秒刷新</p>}
    </section>
  )
}
