import { useEffect, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { useReducedMotion, useSpring } from "motion/react"
import { Bell, ChevronRight, Download, ListChecks, Rss } from "lucide-react"
import type { DownloadCenter, NotificationSummary } from "@/lib/api"
import { spring } from "@/lib/motion"
import { Skeleton } from "@/components/ui/skeleton"
import { formatSpeed, type DashboardSummary, type ModuleQuery } from "./types"

function AnimatedNumber({ value }: { value: number }) {
  const reducedMotion = useReducedMotion()
  const counter = useSpring(value, spring.gentle)
  const [display, setDisplay] = useState(value)
  useEffect(() => counter.on("change", (next) => setDisplay(Math.round(next))), [counter])
  useEffect(() => {
    if (reducedMotion) counter.jump(value)
    else counter.set(value)
  }, [value, reducedMotion, counter])
  return <span aria-hidden="true">{reducedMotion ? value : display}</span>
}

function StatCard({
  label,
  value,
  detail,
  icon,
  href,
  onClick,
  pending,
  failed,
  retry,
}: {
  label: string
  value?: number
  detail: ReactNode
  icon: ReactNode
  href?: string
  onClick?: () => void
  pending: boolean
  failed: boolean
  retry: () => unknown
}) {
  const content = (
    <>
      <span className="dashboard-stat-label">
        {icon}
        {label}
        <ChevronRight size={14} className="dashboard-stat-chevron" aria-hidden="true" />
      </span>
      {pending ? (
        <Skeleton className="my-2 h-8 w-16" />
      ) : (
        <strong className="dashboard-stat-value">{value === undefined ? "—" : <AnimatedNumber value={value} />}</strong>
      )}
      <span className="dashboard-stat-detail">{failed ? "读取失败，点击重试" : detail}</span>
    </>
  )
  const ariaLabel = failed
    ? `${label}读取失败，点击重试`
    : `${label}：${value ?? "读取中"}，${typeof detail === "string" ? detail : "查看详情"}`
  if (failed)
    return (
      <button type="button" className="dashboard-stat" aria-label={ariaLabel} onClick={() => void retry()}>
        {content}
      </button>
    )
  if (href)
    return (
      <Link className="dashboard-stat" to={href} aria-label={ariaLabel}>
        {content}
      </Link>
    )
  return (
    <button type="button" className="dashboard-stat" aria-label={ariaLabel} onClick={onClick}>
      {content}
    </button>
  )
}

export function StatStrip({
  dashboard,
  downloads,
  notifications,
}: {
  dashboard: ModuleQuery<DashboardSummary>
  downloads: ModuleQuery<DownloadCenter>
  notifications: ModuleQuery<NotificationSummary>
}) {
  const active = downloads.data?.tasks.filter((task) => task.status === "downloading").length
  return (
    <section className="dashboard-stat-strip" aria-label="状态总览">
      <StatCard
        label="订阅健康"
        icon={<Rss size={16} aria-hidden="true" />}
        href="/feeds"
        value={dashboard.data?.healthy_feeds}
        detail={dashboard.data ? `共 ${dashboard.data.feeds} 个订阅` : "正在读取订阅"}
        pending={dashboard.isPending}
        failed={dashboard.isError}
        retry={dashboard.refetch}
      />
      <StatCard
        label="正在下载"
        icon={<Download size={16} aria-hidden="true" />}
        href="/downloads"
        value={active}
        detail={downloads.data ? `总速度 ${formatSpeed(downloads.data.download_speed)}` : "正在读取下载"}
        pending={downloads.isPending}
        failed={downloads.isError}
        retry={downloads.refetch}
      />
      <StatCard
        label="待审核"
        icon={<ListChecks size={16} aria-hidden="true" />}
        href="/review"
        value={dashboard.data?.needs_review}
        detail="查看需要处理的发布"
        pending={dashboard.isPending}
        failed={dashboard.isError}
        retry={dashboard.refetch}
      />
      <StatCard
        label="后台提醒"
        icon={<Bell size={16} aria-hidden="true" />}
        value={notifications.data?.unread_count}
        detail={`未读提醒 · ${notifications.data?.active_count ?? 0} 项进行中`}
        onClick={() => window.dispatchEvent(new CustomEvent("mooncell:open-notifications"))}
        pending={notifications.isPending}
        failed={notifications.isError}
        retry={notifications.refetch}
      />
    </section>
  )
}
