import { AddSubscriptionButton } from "@/components/add-subscription-button"
import { AddSubscriptionDialog } from "@/components/feeds/add-subscription-dialog"
import { PageHeading } from "@/components/page-heading"
import { Skeleton } from "@/components/ui/skeleton"
import { ModuleSkeleton } from "@/components/dashboard/module-state"

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

/** 仅用于路由代码的 Suspense；数据请求由首页各模块独立呈现。 */
export function DashboardLoading() {
  return (
    <div className="dashboard-v2">
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
        <div className="dashboard-panel">
          <ModuleSkeleton label="正在加载今日放送" rows={4} />
        </div>
        <div className="dashboard-panel">
          <ModuleSkeleton label="正在加载下载任务" />
        </div>
      </div>
    </div>
  )
}
