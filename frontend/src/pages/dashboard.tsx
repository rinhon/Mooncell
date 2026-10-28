import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { api, type DownloadCenter, type Show } from "@/lib/api"
import { useNotifications } from "@/hooks/use-notifications"
import { AddSubscriptionDialog } from "@/components/feeds/add-subscription-dialog"
import { DashboardHeading } from "@/components/dashboard-loading"
import { StatStrip } from "@/components/dashboard/stat-strip"
import { TodaySchedule } from "@/components/dashboard/today-schedule"
import { ActiveDownloads } from "@/components/dashboard/active-downloads"
import { RecentReleases } from "@/components/dashboard/recent-releases"
import { RecentShows } from "@/components/dashboard/recent-shows"
import { MagicBento } from "@/components/ui/magic-bento"
import type { DashboardSummary, SeasonCalendar } from "@/components/dashboard/types"

export function DashboardPage() {
  const [visible, setVisible] = useState(() => !document.hidden)
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const visibility = () => {
      setVisible(!document.hidden)
      setNow(new Date())
    }
    document.addEventListener("visibilitychange", visibility)
    const timer = window.setInterval(() => setNow(new Date()), 60_000)
    return () => {
      document.removeEventListener("visibilitychange", visibility)
      window.clearInterval(timer)
    }
  }, [])
  const dashboard = useQuery({
    queryKey: ["dashboard"],
    queryFn: ({ signal }) => api<DashboardSummary>("/dashboard", { signal }),
    refetchInterval: 60_000,
  })
  const downloads = useQuery({
    queryKey: ["downloads"],
    queryFn: ({ signal }) => api<DownloadCenter>("/downloads", { signal }),
    enabled: visible,
    refetchInterval: visible ? 5_000 : false,
    refetchIntervalInBackground: false,
  })
  const shows = useQuery({
    queryKey: ["shows"],
    queryFn: ({ signal }) => api<Show[]>("/shows", { signal }),
  })
  // 与日历页共用当季缓存，喜欢状态的乐观更新会立即同步到首页。
  const calendar = useQuery({
    queryKey: ["season-calendar", null],
    queryFn: ({ signal }) => api<SeasonCalendar>("/calendar", { signal }),
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: false,
  })
  const { summary } = useNotifications(false)
  return (
    <MagicBento className="dashboard-v2 dashboard-magic-bento">
      <DashboardHeading count={shows.data?.length} />
      <StatStrip dashboard={dashboard} downloads={downloads} notifications={summary} />
      {dashboard.data?.feeds === 0 && (
        <section className="dashboard-onboarding" aria-labelledby="dashboard-start-title">
          <div>
            <h2 id="dashboard-start-title">从第一部番剧开始</h2>
            <p>添加 RSS 订阅后，这里会显示你的番剧与发布信息。</p>
          </div>
          <AddSubscriptionDialog />
        </section>
      )}
      <div className="dashboard-main-grid">
        <TodaySchedule query={calendar} now={now} />
        <RecentReleases query={dashboard} shows={shows.data ?? []} tasks={downloads.data?.tasks ?? []} />
        <ActiveDownloads query={downloads} />
      </div>
      <RecentShows query={shows} />
    </MagicBento>
  )
}
