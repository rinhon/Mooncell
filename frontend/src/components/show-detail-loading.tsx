import { Skeleton } from "@/components/ui/skeleton"
import "@/pages/show-detail.css"

export function ShowDetailLoading() {
  return <div className="show-detail" role="status" aria-label="正在加载番剧详情" aria-busy="true">
    <span className="sr-only">正在加载番剧详情…</span><Skeleton className="mb-8 h-5 w-28"/>
    <div className="detail-grid">
      <aside className="detail-artwork"><Skeleton className="detail-poster"/><div className="detail-manage"><Skeleton className="h-5 w-24"/></div><div className="detail-artwork-state"><Skeleton className="h-4 w-full"/></div></aside>
      <div className="detail-main"><div className="detail-kicker"><Skeleton className="h-4 w-full max-w-40"/></div><h1 aria-hidden="true"><Skeleton className="h-28 w-full"/></h1><div className="detail-facts"><Skeleton className="h-6 w-full max-w-96"/></div><div className="detail-genres"><Skeleton className="h-4 w-28"/></div><div className="detail-overview"><Skeleton className="h-24 w-full"/></div><div className="detail-actions"><Skeleton className="h-14 w-full max-w-96"/></div><div className="detail-tabs"><Skeleton className="h-12 w-56"/></div><div className="detail-panel"><Skeleton className="mt-6 h-56 w-full"/></div></div>
    </div>
  </div>
}
