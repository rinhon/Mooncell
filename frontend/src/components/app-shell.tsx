import { NativeButton } from "@/components/ui/button"
import { useRef, useState, type PointerEvent, type ReactNode } from "react"
import { LayoutGroup, motion, useReducedMotion } from "motion/react"
import { NavLink, useLocation, useNavigate } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { CalendarDays, Download, FileCheck2, FolderCheck, LayoutDashboard, ListFilter, RadioTower, Settings2, Tv2 } from "lucide-react"
import StrokeText from "@/components/stroke-text"
import { api, type Show, type DownloadCenter } from "@/lib/api"
import { cn } from "@/lib/utils"
import { useOverflowMenu } from "@/hooks/use-overflow-menu"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu"


const navigation = [
  { to: "/", label: "首页", icon: LayoutDashboard },
  { to: "/shows", label: "番剧", icon: Tv2 },
  { to: "/feeds", label: "订阅", icon: RadioTower },
  { to: "/downloads", label: "下载", icon: Download },
  { to: "/organizer", label: "整理", icon: FolderCheck },
  { to: "/calendar", label: "日历", icon: CalendarDays },
]
const utilities = [
  { to: "/review", label: "审核", icon: ListFilter },
  { to: "/logs", label: "日志", icon: FileCheck2 },
  { to: "/settings", label: "设置", icon: Settings2 },
]

/** 顶部导航保持固定，页面内容在下方工作区切换。 */
export function AppShell({ children }: { children: ReactNode }) {
  const location = useLocation()
  const reducedMotion = useReducedMotion()
  const navigate = useNavigate()

  const navigationRef = useRef<HTMLElement>(null)
  const { measureRef, visibleCount } = useOverflowMenu(navigationRef, navigation.length)
  const hiddenNavigation = navigation.slice(visibleCount)
  const hiddenCurrent = hiddenNavigation.find(item => item.to === location.pathname)
  const [hoveredTo, setHoveredTo] = useState<string | null>(null)

  function moveNavigationGlow(event: PointerEvent<HTMLElement>) {
    if (event.pointerType === "touch") return
    const surface = event.currentTarget
    const bounds = surface.getBoundingClientRect()
    surface.style.setProperty("--pointer-x", `${event.clientX - bounds.left}px`)
    surface.style.setProperty("--pointer-y", `${event.clientY - bounds.top}px`)
    surface.dataset.pointer = "true"
  }

  function hideNavigationGlow(event: PointerEvent<HTMLElement>) {
    delete event.currentTarget.dataset.pointer
    setHoveredTo(null)
  }



  return <div className="app-frame">
    {/* 吸顶导航的共享布局动画相对顶栏测量，避免页面滚动距离混入指示条位移。 */}
    <motion.header layoutRoot className="top-navigation" onPointerMove={moveNavigationGlow} onPointerLeave={hideNavigationGlow} onPointerCancel={hideNavigationGlow}>
      <span className="navigation-glow" aria-hidden="true"/>
      <NativeButton className="brand-mark" aria-label="MOONCELL · 返回首页" onPointerEnter={() => setHoveredTo(null)} onClick={() => navigate("/")}><StrokeText text="MOONCELL" trigger="hover" playOnMount strokeColor="var(--accent)" fillColor="var(--accent)" fontSize={28} fontWeight={800} letterSpacing={1.2} strokeWidth={0.7} drawDuration={0.9} fillDelay={0.1} stagger={0.045}/></NativeButton>
      <LayoutGroup id="main-navigation"><nav ref={navigationRef} className="top-links" aria-label="主要导航">
        <div ref={measureRef} className="overflow-measure" aria-hidden="true" inert>{navigation.map(({ label, icon: Icon }) => <span className="top-link" key={label}><Icon size={18}/><span>{label}</span></span>)}</div>
        {navigation.slice(0, visibleCount).map(({ to, label, icon: Icon }) => <NavLink key={to} end={to === "/"} to={to} onPointerEnter={event => {
          if (event.pointerType === "mouse") setHoveredTo(to)
        }} className={({ isActive }) => cn("nav-link top-link", isActive && "active")}>{({ isActive }) => <>
          {hoveredTo === to && <motion.span className="navigation-hover" data-visible="true" aria-hidden="true" layoutId="hover" transition={{ type: "spring", stiffness: 400, damping: 32 }}/>}<Icon size={18} strokeWidth={1.45}/><span>{label}</span>
          {isActive && <motion.i className="rail-slider" aria-hidden="true" layoutId="active" transition={{ type: "spring", stiffness: 400, damping: 32 }}/>}</>}</NavLink>)}
        {hiddenNavigation.length > 0 && <DropdownMenu><DropdownMenuTrigger asChild><button className={cn("top-link overflow-trigger", hiddenCurrent && "active")} onPointerEnter={() => setHoveredTo(null)} aria-label="更多导航">{hiddenCurrent ? hiddenCurrent.label : "更多"}<span aria-hidden="true">▾</span></button></DropdownMenuTrigger><DropdownMenuContent align="end">{hiddenNavigation.map(({ to, label, icon: Icon }) => <DropdownMenuItem key={to} asChild><NavLink to={to} end={to === "/"}><Icon size={16}/>{label}{location.pathname === to && <span aria-hidden="true">✓</span>}</NavLink></DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>}
      </nav>
      <div className="top-actions">
        <nav className="utility-navigation" aria-label="管理工具">{utilities.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} title={label} aria-label={label} onPointerEnter={event => {
          if (event.pointerType === "mouse") setHoveredTo(to)
        }} className={({ isActive }) => cn("utility-link", isActive && "active")}>{hoveredTo === to && <motion.span className="navigation-hover" data-visible="true" aria-hidden="true" layoutId="hover" transition={{ type: "spring", stiffness: 400, damping: 32 }}/>}<Icon size={17} strokeWidth={1.5}/></NavLink>)}</nav>
      </div></LayoutGroup>
    </motion.header>

    <section className="app-workspace">
      <main className="content-stage"><motion.div key={location.pathname} className="page-content" initial={reducedMotion ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ type: "spring", stiffness: 380, damping: 34 }}>{children}</motion.div></main>
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
      <p className="micro-label">媒体库状态</p>
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
