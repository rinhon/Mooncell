import { Skeleton } from "@/components/ui/skeleton"
import "@/pages/show-detail.css"

export function ShowDetailLoading() {
  return (
    <div className="show-detail" role="status" aria-label="正在加载番剧详情" aria-busy="true">
      <span className="sr-only">正在加载番剧详情…</span>
      <Skeleton className="mb-8 h-5 w-28" />
      <div className="detail-grid">
        <aside className="detail-artwork">
          <Skeleton className="detail-poster" />
        </aside>
        <div className="detail-main">
          <div className="detail-kicker">
            <Skeleton className="h-4 w-full max-w-40" />
          </div>
          <div className="detail-title">
            <h1 aria-hidden="true">
              <Skeleton className="h-20 w-full" />
            </h1>
          </div>
          <div className="detail-facts">
            <Skeleton className="h-6 w-full max-w-96" />
          </div>
          <div className="detail-genres">
            <Skeleton className="h-4 w-28" />
          </div>
          <div className="detail-overview">
            <Skeleton className="h-20 w-full" />
          </div>
          <div className="detail-primary-actions">
            <Skeleton className="h-11 w-full max-w-96" />
          </div>
          <div className="detail-tabs">
            <Skeleton className="h-12 w-56" />
          </div>
          <div className="detail-panel">
            <Skeleton className="mt-6 h-40 w-full" />
          </div>
        </div>
      </div>
    </div>
  )
}
