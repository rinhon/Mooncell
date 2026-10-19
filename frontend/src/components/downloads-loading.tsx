import type { ReactNode } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { Database, DownloadCloud, Router, Zap } from "lucide-react"
import { PageHeading } from "@/components/page-heading"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"

export function DownloadsHeading({ sourceId, sourceName }: { sourceId?: string | null; sourceName?: string }) {
  return <>
    <PageHeading eyebrow="Transfers" title="下载中心" description="订阅刷新后自动投递至 qBittorrent，获取文件结构后按订阅季度整理和重命名。状态每 3 秒同步。"/>
    {sourceId && <p className="mb-4 text-sm text-[var(--muted)]">当前仅显示 {sourceName ?? "所选订阅"} 的下载任务。<Link className="ml-3 text-[var(--accent)] underline" to="/downloads">查看全部下载</Link></p>}
  </>
}

function Metric({ icon: Icon, label, value }: { icon: typeof Zap; label: string; value?: string }) {
  return <Card className="min-w-0"><CardContent className="flex min-w-0 items-center gap-3 p-4">
    <span className="grid size-10 shrink-0 place-items-center text-[var(--muted)]"><Icon size={17}/></span>
    <div className="min-w-0"><p className="truncate text-xs text-[var(--muted)]">{label}</p><div className="mt-1 truncate text-sm font-semibold">{value ?? <Skeleton className="h-5 w-20"/>}</div></div>
  </CardContent></Card>
}

export function DownloadsMetrics({ values, downloaderName = "qBittorrent" }: { values?: { speed: string; active: string; records: string; downloader: string }; downloaderName?: string }) {
  return <div className="mb-5 grid grid-cols-2 gap-3 min-[721px]:grid-cols-4">
    <Metric icon={Zap} label="当前下载速度" value={values?.speed}/>
    <Metric icon={DownloadCloud} label="活动任务" value={values?.active}/>
    <Metric icon={Database} label="数据库记录" value={values?.records}/>
    <Metric icon={Router} label={downloaderName} value={values?.downloader}/>
  </div>
}

export function DownloadsRecords({ count, search, children }: { count?: number; search: ReactNode; children: ReactNode }) {
  return <Card>
    <CardHeader className="flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><CardTitle>数据库 BT 记录</CardTitle>{count === undefined ? <Skeleton className="mt-1 h-6 w-96 max-w-full"/> : <CardDescription>{count} 条 RSS 下载地址，通过 info-hash 与 qBittorrent 精确关联</CardDescription>}</div>{search}</CardHeader>
    <CardContent className="grid min-w-0 gap-3">{children}</CardContent>
  </Card>
}

function DownloadRowSkeleton() {
  return <div className="download-row min-w-0 p-4">
    <div className="grid min-w-0 gap-4 sm:grid-cols-[112px_minmax(0,1fr)_auto] sm:items-center">
      <Skeleton className="h-14 w-28"/>
      <div className="min-w-0"><Skeleton className="h-6 w-3/4"/><Skeleton className="mt-1 h-5 w-1/2"/></div>
      <div className="grid justify-items-end"><Skeleton className="h-4 w-28"/><Skeleton className="mt-1 h-5 w-24"/></div>
    </div>
    <div className="mt-4 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2"><Skeleton className="h-[2px] w-full"/><div className="flex items-center gap-2"><Skeleton className="h-6 w-20"/><Skeleton className="h-3 w-8"/></div></div>
  </div>
}

export function DownloadsLoading({ search, sourceName, count = 10 }: { search?: string; sourceName?: string; count?: number }) {
  const [params] = useSearchParams()
  return <>
    <DownloadsHeading sourceId={params.get("source_id")} sourceName={sourceName}/>
    <div role="status" aria-label="正在加载下载中心" aria-busy="true">
      <span className="sr-only">正在读取数据库与 qBittorrent…</span>
      <div aria-hidden="true">
        <DownloadsMetrics/>
        <DownloadsRecords search={<Input type="search" aria-label="搜索动画番剧" placeholder="搜索番剧名称…" value={search ?? params.get("q") ?? ""} disabled className="w-full sm:w-60"/>}>
          <div className="grid min-w-0 gap-3">{Array.from({ length: count }, (_, index) => <DownloadRowSkeleton key={index}/>)}</div>
          <div className="list-pagination"><Skeleton className="h-5 w-36"/><div className="pagination-controls"><Skeleton className="mr-2 h-8 w-[116px]"/>{[0, 1, 2].map(index => <Skeleton key={index} className="size-8"/>)}</div></div>
        </DownloadsRecords>
      </div>
    </div>
  </>
}
