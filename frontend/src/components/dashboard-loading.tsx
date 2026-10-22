import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { AddSubscriptionButton } from "@/components/add-subscription-button"
import { PageHeading } from "@/components/page-heading"
import { Skeleton } from "@/components/ui/skeleton"

export function DashboardHeading({ count, loading = false }: { count?: number; loading?: boolean }) {
  return <PageHeading eyebrow="OVERVIEW" title="首页" description={<>已订阅 {count ?? <span className="skeleton inline-block h-[1em] w-6 align-middle" aria-label="正在读取番剧数量"/>} 部番剧，查看最近发布和下载任务。</>} action={loading ? <AddSubscriptionButton disabled/> : <AddSubscriptionButton to="/feeds"/>}/>
}

export function DashboardRecent({ children, loading = false }: { children: ReactNode; loading?: boolean }) {
  return <section className="recent-section">
    <div className="recent-heading"><p>最近添加</p>{loading ? <span className="text-[var(--muted)]">查看全部</span> : <Link to="/shows">查看全部</Link>}</div>
    <div className="recent-grid">{children}</div>
  </section>
}

export function DashboardLoading() {
  return <div className="dashboard-loading">
    <DashboardHeading loading/>
    <div role="status" aria-label="正在加载首页" aria-busy="true">
      <span className="sr-only">正在读取首页番剧订阅…</span>
      <div aria-hidden="true">
        <div className="dashboard-gallery-skeleton">{[0, 1, 2, 3].map(index => <div key={index} className="relative min-h-0 min-w-0 overflow-hidden rounded-[var(--radius-card)]">
          <Skeleton className="absolute inset-0 size-full"/>
          {index === 0 && <div className="absolute inset-x-6 bottom-7 grid gap-3"><Skeleton className="h-8 w-3/4"/><Skeleton className="h-4 w-2/3"/><Skeleton className="mt-1 h-10 w-28"/></div>}
        </div>)}</div>
        <DashboardRecent loading>{[0, 1, 2, 3, 4].map(index => <div className="recent-item" key={index}>
          <span className="recent-image"><Skeleton className="size-full"/></span>
        </div>)}</DashboardRecent>
      </div>
    </div>
  </div>
}
