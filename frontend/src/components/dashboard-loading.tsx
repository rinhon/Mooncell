import { AddSubscriptionButton } from "@/components/add-subscription-button"
import { AddSubscriptionDialog } from "@/components/feeds/add-subscription-dialog"
import { PageHeading } from "@/components/page-heading"
import { Skeleton } from "@/components/ui/skeleton"
import { ModuleSkeleton } from "@/components/dashboard/module-state"
import { MagicBento } from "@/components/ui/magic-bento"

export function DashboardHeading({ count, loading = false }: { count?: number; loading?: boolean }) {
  return (
    <PageHeading
      eyebrow="状态总览"
      title="首页"
      description={
        count === undefined
          ? "查看订阅、今日放送与下载任务的最新状态。"
          : `已订阅 ${count} 部番剧，查看今日放送、最近发布与下载任务。`
      }
      action={loading ? <AddSubscriptionButton disabled /> : <AddSubscriptionDialog />}
    />
  )
}

/** 路由代码、初始数据与图片尚未就绪时统一显示首页骨架。 */
export function DashboardLoading() {
  return (
    <MagicBento className="dashboard-v2 dashboard-magic-bento" animate={false}>
      <DashboardHeading loading />
      <div className="dashboard-stat-strip" aria-label="正在加载状态总览" role="status" aria-busy="true">
        {[0, 1, 2, 3].map((index) => (
          <div className="dashboard-stat" key={index}>
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-8 w-12" />
            <Skeleton className="h-3 w-28" />
          </div>
        ))}
      </div>
      <div className="dashboard-main-grid">
        <div className="dashboard-panel dashboard-today">
          <ModuleSkeleton label="正在加载今日放送" rows={4} />
        </div>
        <div className="dashboard-panel dashboard-releases">
          <ModuleSkeleton label="正在加载最新发布" rows={3} />
        </div>
        <div className="dashboard-panel dashboard-downloads">
          <ModuleSkeleton label="正在加载下载任务" />
        </div>
      </div>
      <div
        className="dashboard-panel dashboard-recent-shows"
        role="status"
        aria-label="正在加载最近添加的番剧"
        aria-busy="true"
      >
        <div className="dashboard-panel-heading" aria-hidden="true">
          <div className="grid gap-2">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-3 w-32" />
          </div>
          <Skeleton className="h-4 w-14 self-start" />
        </div>
        <div className="dashboard-poster-grid dashboard-poster-skeleton-grid" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((index) => (
            <div key={index} className="dashboard-poster-link">
              <Skeleton className="dashboard-poster-image w-full" />
              <Skeleton className="mt-1 h-5 w-4/5" />
              <Skeleton className="h-4 w-3/5" />
            </div>
          ))}
        </div>
      </div>
    </MagicBento>
  )
}
