import { useEffect, useMemo, useRef, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { Database, DownloadCloud, HardDriveDownload, Router, Zap } from "lucide-react"
import { api, type DownloadCenter, type DownloadTask, type Show } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { PageHeading } from "@/components/page-heading"
import { Progress } from "@/components/ui/progress"
import { Pagination } from "@/components/ui/pagination"
import { Input } from "@/components/ui/input"

const qbStateLabels: Record<string, string> = {
  error: "发生错误",
  missingFiles: "文件丢失",
  uploading: "做种中",
  pausedUP: "做种已暂停",
  stoppedUP: "做种已停止",
  queuedUP: "排队做种中",
  stalledUP: "等待上传连接",
  checkingUP: "校验已下载文件中",
  forcedUP: "强制做种中",
  allocating: "分配磁盘空间中",
  downloading: "下载中",
  metaDL: "获取元数据中",
  forcedMetaDL: "强制获取元数据中",
  pausedDL: "下载已暂停",
  stoppedDL: "下载已停止",
  queuedDL: "排队下载中",
  stalledDL: "等待下载连接",
  checkingDL: "校验未完成文件中",
  forcedDL: "强制下载中",
  checkingResumeData: "检查恢复数据中",
  moving: "移动文件中",
  unknown: "未知状态",
}

function qbStateLabel(state: string | null | undefined): string {
  if (!state) return "未找到对应任务"
  return qbStateLabels[state] ?? "未知状态"
}

/** 数据库下载记录与 qBittorrent 实时状态的合并视图。 */
export function DownloadsPage() {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [searchParams, setSearchParams] = useSearchParams()
  const sourceFilter = searchParams.get("q") ?? ""
  const [searchInput, setSearchInput] = useState(sourceFilter)
  const isComposing = useRef(false)
  useEffect(() => {
    if (!isComposing.current) setSearchInput(sourceFilter)
  }, [sourceFilter])
  function setSourceFilter(value: string) {
    setPage(1)
    if (value === sourceFilter) return
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous)
      if (value) next.set("q", value)
      else next.delete("q")
      return next
    }, { replace: true })
  }
  const shows = useQuery({ queryKey: ["shows"], queryFn: () => api<Show[]>("/shows") })
  const clearlogos = new Map(shows.data?.filter((show) => show.clearlogo_ready).map((show) => [
    show.id, `/api/v1/shows/${show.id}/artwork/clearlogo?v=${encodeURIComponent(show.artwork_version ?? "")}`,
  ]))
  const center = useQuery({
    queryKey: ["downloads"],
    queryFn: () => api<DownloadCenter>("/downloads"),
    refetchInterval: 3000,
    refetchIntervalInBackground: true,
  })
  const data = center.data
  const tasks = data?.tasks ?? []
  const active = tasks.filter((task) => task.status === "downloading").length
  const matched = tasks.filter((task) => task.matched).length
  const filteredTasks = useMemo(() => {
    const keyword = sourceFilter.trim().toLocaleLowerCase()
    return keyword ? tasks.filter((task) => task.source_name.toLocaleLowerCase().includes(keyword)) : tasks
  }, [tasks, sourceFilter])
  const pageCount = Math.max(1, Math.ceil(filteredTasks.length / pageSize))
  const currentPage = Math.min(page, pageCount)
  const pageTasks = useMemo(() => filteredTasks.slice((currentPage - 1) * pageSize, currentPage * pageSize), [filteredTasks, currentPage, pageSize])
  useEffect(() => { setPage((value) => Math.min(value, pageCount)) }, [pageCount])

  return <>
    <PageHeading eyebrow="Transfers" title="下载中心" description="订阅刷新后自动投递至 qBittorrent，获取文件结构后按订阅季度整理和重命名。状态每 3 秒同步。"/>
    <div className="mb-5 grid grid-cols-2 gap-3 min-[721px]:grid-cols-4">
      <Metric icon={Zap} label="当前下载速度" value={formatSpeed(data?.download_speed ?? 0)}/>
      <Metric icon={DownloadCloud} label="活动任务" value={`${active} 个`}/>
      <Metric icon={Database} label="数据库记录" value={`${tasks.length} 条 · 匹配 ${matched} 条`}/>
      <Metric icon={Router} label={data?.downloader_name ?? "qBittorrent"} value={data?.downloader_online ? `${data.downloader_version ?? ""} · 在线` : data?.downloader_configured ? "离线" : "未配置"}/>
    </div>
    {data?.error && <p className="mb-4 rounded-[2px] border border-[var(--danger-line)] bg-[var(--danger-soft)] px-4 py-3 text-sm text-[var(--danger)]">qBittorrent 同步失败：{data.error}</p>}
    <Card>
      <CardHeader className="flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between"><div><CardTitle>数据库 BT 记录</CardTitle><CardDescription>{filteredTasks.length} 条 RSS 下载地址，通过 info-hash 与 qBittorrent 精确关联</CardDescription></div>
        <Input type="search" aria-label="搜索动画番剧" placeholder="搜索番剧名称…" value={searchInput}
          onCompositionStart={() => { isComposing.current = true }}
          onCompositionEnd={(event) => {
            isComposing.current = false
            setSearchInput(event.currentTarget.value)
            setSourceFilter(event.currentTarget.value)
          }}
          onChange={(event) => {
            // Keep IME drafts local: router navigation can interrupt composition.
            setSearchInput(event.target.value)
            if (!isComposing.current) setSourceFilter(event.target.value)
          }} className="w-full sm:w-60"/>
      </CardHeader>
      <CardContent className="grid min-w-0 gap-3">
        {filteredTasks.length > 0 && <ul aria-label="下载任务列表" className="m-0 grid min-w-0 list-none gap-3 p-0">{pageTasks.map((task) => <li key={task.id} className="min-w-0"><DownloadRow task={task} logoUrl={clearlogos.get(task.source_id)}/></li>)}</ul>}
        {center.isLoading && <div className="grid min-h-56 place-items-center text-sm text-[var(--muted)]">正在读取数据库与 qBittorrent…</div>}
        {!center.isLoading && !tasks.length && <div className="grid min-h-56 place-items-center text-center"><div><HardDriveDownload className="mx-auto text-[var(--muted)]" size={30}/><p className="mt-3 text-sm font-medium">数据库中还没有 BT 记录</p><p className="mt-1 text-[13px] text-[var(--muted)]">刷新 RSS 后，torrent 或 magnet 地址会显示在这里。</p></div></div>}
        {!center.isLoading && tasks.length > 0 && !filteredTasks.length && <p className="py-12 text-center text-sm text-[var(--muted)]">未找到匹配的番剧，请更换关键词或清空搜索。</p>}
        {filteredTasks.length > 0 && <Pagination total={filteredTasks.length} page={currentPage} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={(size) => { setPageSize(size); setPage(1) }}/>} 
      </CardContent>
    </Card>
  </>
}

function DownloadRow({ task, logoUrl }: { task: DownloadTask; logoUrl?: string }) {
  const [failedLogo, setFailedLogo] = useState<string | null>(null)
  const status = statusDisplay(task)
  const completed = task.status === "completed" || task.progress >= 100
  const completedActivity = task.status === "paused" || task.status === "failed" || task.status === "checking"
    ? qbStateLabel(task.qb_state) : "做种中"
  return <div className="download-row min-w-0 p-4 transition-colors">
    <div className="grid min-w-0 gap-4 sm:grid-cols-[112px_minmax(0,1fr)_auto] sm:items-center">
      <div className={`grid h-14 w-28 shrink-0 place-items-center ${task.matched ? "text-[var(--ink-2)]" : "text-[var(--faint)]"}`}>
        {logoUrl && failedLogo !== logoUrl ? <img src={logoUrl} alt="" className="max-h-full max-w-full object-contain" loading="lazy" onError={() => setFailedLogo(logoUrl)}/> : <HardDriveDownload size={18}/>}
      </div>
      <div className="min-w-0 flex-1">
        <p className="block min-w-0 truncate font-semibold" title={task.title}>{task.title}</p>
        <p className="mt-1 truncate text-[13px] text-[var(--muted)]">{task.source_name} · {task.info_hash ?? "未解析 info-hash"}</p>
      </div>
      <div className="whitespace-nowrap text-right text-xs text-[var(--muted)]"><p>{formatBytes(task.downloaded)} / {formatBytes(task.size)}</p><p className="mt-1 text-[13px]">{completed ? completedActivity : <>{formatSpeed(task.download_speed)} · {formatEta(task.eta)}</>}</p></div>
    </div>
    <div className="mt-4 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2"><Progress value={task.progress} indicatorClassName={task.status === "failed" ? "bg-[var(--danger)]" : task.status === "completed" ? "bg-[var(--success)]" : "bg-[var(--accent)]"}/><div className="flex items-center gap-2 whitespace-nowrap"><Badge tone={status.tone}>{status.label === "下载中" ? qbStateLabel(task.qb_state) : status.label}</Badge><span className="text-xs font-medium leading-none tabular-nums text-[var(--muted)]">{task.progress.toFixed(task.progress % 1 ? 1 : 0)}%</span></div></div>
    {task.automation_error && <p className="mt-2 break-words text-xs text-[var(--danger)]">自动下载：{task.automation_error}</p>}
    {task.review_required && <div className="mt-3 flex justify-end"><Link className="text-sm text-[var(--accent)] underline underline-offset-4" to={`/review?q=${encodeURIComponent(task.source_name)}`}>前往审核</Link></div>}
  </div>
}

function statusDisplay(task: DownloadTask): { label: string; tone: "success" | "warning" | "danger" | "neutral" } {
  if (task.automation_state === "superseded") return { label: "已被新版取代", tone: "neutral" }
  if (task.automation_state === "upgrading") return { label: "修订版升级中", tone: "neutral" }
  if (task.automation_state === "replacing") return { label: "等待新版替换", tone: "neutral" }
  if (task.automation_state === "ignored") return { label: "已忽略", tone: "neutral" }
  if (task.review_required) return { label: "待审核", tone: "warning" }
  if (task.automation_state === "needs_review") return { label: "整理待审核", tone: "warning" }
  if (task.automation_error) return { label: "自动下载异常", tone: "danger" }
  if (task.automation_state === "queued") return { label: "等待自动投递", tone: "neutral" }
  if (task.automation_state === "metadata") return { label: "获取文件结构", tone: "neutral" }
  if (["organizing", "moving"].includes(task.automation_state ?? "")) return { label: "整理目录中", tone: "neutral" }
  if (!task.matched) return { label: "未加入 qBittorrent", tone: "neutral" }
  if (task.status === "completed") return { label: "已完成", tone: "success" }
  if (task.status === "paused") return { label: "已暂停", tone: "warning" }
  if (task.status === "failed") return { label: "异常", tone: "danger" }
  if (task.status === "queued") return { label: "排队中", tone: "neutral" }
  if (task.status === "checking") return { label: "校验中", tone: "neutral" }
  return { label: "下载中", tone: "neutral" }
}

function formatBytes(value: number): string {
  if (!value) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  return `${(value / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`
}

function formatSpeed(value: number): string { return `${formatBytes(value)}/s` }

function formatEta(value?: number): string {
  if (value === undefined || value === null) return "--"
  if (value < 60) return `${value} 秒`
  if (value < 3600) return `${Math.ceil(value / 60)} 分钟`
  return `${Math.ceil(value / 3600)} 小时`
}

function Metric({ icon: Icon, label, value }: { icon: typeof Zap; label: string; value: string }) {
  return <Card className="min-w-0"><CardContent className="flex min-w-0 items-center gap-3 p-4"><span className="grid size-10 shrink-0 place-items-center text-[var(--muted)]"><Icon size={17}/></span><div className="min-w-0"><p className="truncate text-xs text-[var(--muted)]">{label}</p><p className="mt-1 truncate text-sm font-semibold">{value}</p></div></CardContent></Card>
}
