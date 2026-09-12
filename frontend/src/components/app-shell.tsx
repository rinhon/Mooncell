import { NativeButton } from "@/components/ui/button"
import { useState, type MouseEvent, type ReactNode } from "react"
import { NavLink, useLocation, useNavigate } from "react-router-dom"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { CalendarDays, CircleDotDashed, Download, FileCheck2, FolderCheck, LayoutDashboard, ListFilter, LogOut, RadioTower, RefreshCw, Settings2, Tv2 } from "lucide-react"
import { api, type Show, type DownloadCenter } from "@/lib/api"
import { cn } from "@/lib/utils"


const navigation = [
  { to: "/", label: "总览", icon: LayoutDashboard },
  { to: "/shows", label: "番剧", icon: Tv2 },
  { to: "/feeds", label: "订阅", icon: RadioTower },
  { to: "/downloads", label: "下载", icon: Download },
  { to: "/organizer", label: "整理", icon: FolderCheck },
  { to: "/calendar", label: "日历", icon: CalendarDays },
  { to: "/review", label: "审核", icon: ListFilter },

  { to: "/settings", label: "设置", icon: Settings2 },
  { to: "/logs", label: "日志", icon: FileCheck2 },
]

/** 参考媒体库控制台的稳定三栏框架，页面内容只在中央舞台切换。 */
export function AppShell({ children }: { children: ReactNode }) {
  const location = useLocation()
  const navigate = useNavigate()
  const client = useQueryClient()

  const [syncing, setSyncing] = useState(false)
  const current = navigation.find((item) => item.to === location.pathname) ?? navigation[0]

  function navigateAnimated(event: MouseEvent<HTMLAnchorElement>, to: string) {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    const viewDocument = document as Document & { startViewTransition?: (update: () => void) => void }
    if (viewDocument.startViewTransition) viewDocument.startViewTransition(() => navigate(to))
    else navigate(to)
  }


  async function refreshAll() {
    setSyncing(true)
    await client.invalidateQueries()
    window.setTimeout(() => setSyncing(false), 500)
  }

  return <div className="app-frame">
    <aside className="desktop-nav" aria-label="主要导航">
      <NativeButton className="brand-mark" aria-label="返回总览" onClick={() => navigate("/")}><CircleDotDashed size={36} strokeWidth={1.25}/></NativeButton>
      <nav className="rail-links">{navigation.map(({ to, label, icon: Icon }) => <NavLink key={to} end={to === "/"} to={to} onClick={(event) => navigateAnimated(event, to)} className={({ isActive }) => cn("nav-link rail-link", isActive && "active")}><Icon size={21} strokeWidth={1.45}/><span>{label}</span><i className="rail-slider" aria-hidden="true"/></NavLink>)}</nav>
      <div className="rail-footer">
        <NativeButton className="sync-orbit" onClick={() => void refreshAll()} aria-label="同步全部数据"><RefreshCw size={18} className={syncing ? "animate-spin" : ""}/></NativeButton>
        <span>{syncing ? "正在同步" : "刷新数据"}</span>
        <small>{syncing ? "请稍候" : "点击同步"}</small>
        <NativeButton className="logout-link" onClick={() => void api("/auth/logout", { method: "POST" }).then(() => client.invalidateQueries({ queryKey: ["auth"] }))}><LogOut size={13}/>退出</NativeButton>
      </div>
    </aside>

    <section className="app-workspace">
      <header className="global-bar">
        <div className="global-context"><span>MOONCELL</span><i>/</i><strong>{current.label}</strong></div>
      </header>
      <nav className="mobile-nav" aria-label="移动端导航">{navigation.map(({to,label,icon:Icon}) => <NavLink key={to} end={to === "/"} to={to} onClick={(event)=>navigateAnimated(event,to)} className={({isActive})=>cn("nav-link mobile-link",isActive&&"active")}><Icon size={16}/>{label}</NavLink>)}</nav>
      <main className="content-stage"><div key={location.pathname} className="page-content">{children}</div></main>
    </section>

    <SystemRail />
  </div>
}

function SystemRail() {
  const shows = useQuery({ queryKey: ["shows"], queryFn: () => api<Show[]>("/shows") })
  const downloads = useQuery({ queryKey: ["downloads"], queryFn: () => api<DownloadCenter>("/downloads"), refetchInterval: 3000 })
  const navigate = useNavigate()
  const tasks = downloads.data?.tasks ?? []
  const active = tasks.filter((task) => task.status === "downloading")
  const unavailable = downloads.isError || Boolean(downloads.data?.error)
  return <aside className="system-rail" aria-label="系统状态">
    <section className="system-block library-status">
      <p className="micro-label">LIBRARY STATUS</p>
      <p className="library-count"><strong>{shows.data ? String(shows.data.length).padStart(2, "0") : "—"}</strong><span>部作品</span></p>
      <p>{shows.isError ? "订阅读取失败" : shows.isPending ? "正在读取订阅" : "已保存的番剧订阅"}</p>
    </section>
    <section className="system-block active-summary">
      <NativeButton onClick={() => navigate("/downloads")}><span>正在下载</span><strong>{downloads.isPending || unavailable ? "—" : String(active.length).padStart(2, "0")}</strong><span>›</span></NativeButton>
    </section>
    <section className="system-block queue-summary">
      <p className="micro-label">下载任务</p>
      {tasks.slice(0, 3).map((item) => <div className="queue-line" key={item.id}><span>{item.title}</span><strong>{item.progress.toFixed(0)}%</strong><i/></div>)}
      {!tasks.length && <p className="empty-queue">{downloads.isPending ? "正在读取下载任务" : unavailable ? "下载任务读取失败" : "暂无下载任务"}</p>}
    </section>
  </aside>
}
