import { NotificationCenter } from "@/components/notification-center"
import { NativeButton } from "@/components/ui/button"
import { GradualBlur } from "@/components/ui/gradual-blur"
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import { motion, useReducedMotion } from "motion/react"
import { NavLink, useLocation, useNavigate } from "react-router-dom"
import { CalendarDays, Download, FileCheck2, FolderCheck, LayoutDashboard, ListFilter, RadioTower, Settings2, Tv2 } from "lucide-react"
import StrokeText from "@/components/stroke-text"
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

/** 指示器使用导航自身的坐标，只动画横向位置，页面滚动不参与测量。 */
function useNavigationBounds(container: RefObject<HTMLElement | null>, target: string | null, layoutVersion = 0) {
  const [bounds, setBounds] = useState<{ x: number; width: number } | null>(null)
  const [visible, setVisible] = useState(false)
  useLayoutEffect(() => {
    const row = container.current
    if (!row) return
    const measure = () => {
      const link = row.querySelector<HTMLElement>(".top-link.active")
      if (!target || !link) { setVisible(false); return }
      const inset = 16
      setBounds({ x: link.offsetLeft + inset, width: Math.max(0, link.offsetWidth - inset * 2) })
      setVisible(true)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    for (const link of row.querySelectorAll("a[href]")) observer.observe(link)
    return () => observer.disconnect()
  }, [container, target, layoutVersion])
  return { bounds, visible }
}

const indicatorBaseWidth = 86

function NavigationIndicator({ bounds, visible }: ReturnType<typeof useNavigationBounds>) {
  const reducedMotion = useReducedMotion()
  if (!bounds) return null
  return <motion.span className="rail-slider" aria-hidden="true" data-visible={visible || undefined}
    initial={false} style={{ left: 0, right: "auto", width: indicatorBaseWidth, height: 3, transformOrigin: "left" }}
    animate={{ x: bounds.x, scaleX: bounds.width / indicatorBaseWidth, opacity: visible ? 1 : 0 }}
    transition={reducedMotion ? { duration: 0 } : { x: { type: "spring", stiffness: 400, damping: 32 }, scaleX: { type: "spring", stiffness: 400, damping: 32 }, opacity: { duration: .12 } }}
  />
}

/** 顶部导航保持固定，页面内容在下方工作区切换。 */
export function AppShell({ children }: { children: ReactNode }) {
  const location = useLocation()
  const detailRoute = /^\/shows\/[^/]+\/?$/.test(location.pathname)
  const reducedMotion = useReducedMotion()
  const navigate = useNavigate()

  const navigationRef = useRef<HTMLElement>(null)
  const { measureRef, visibleCount } = useOverflowMenu(navigationRef, navigation.length)
  const hiddenNavigation = navigation.slice(visibleCount)
  const hiddenCurrent = hiddenNavigation.find(item => (item.to === location.pathname || (item.to !== "/" && location.pathname.startsWith(`${item.to}/`))))
  const navigationActive = useNavigationBounds(navigationRef, location.pathname, visibleCount)

  return <div className={cn("app-frame", detailRoute && "is-show-detail")}>
    <header className="top-navigation">
      <GradualBlur position="top" height="108px" strength={2.6} divCount={6} curve="bezier" tint="var(--shell-top-tint)" className="top-navigation-blur"/>
      <NativeButton className="brand-mark" aria-label="MOONCELL · 返回首页" onClick={() => navigate("/")}><StrokeText text="MOONCELL" trigger="hover" playOnMount strokeColor="var(--accent)" fillColor="var(--accent)" fontSize={28} fontWeight={800} letterSpacing={1.2} strokeWidth={0.7} drawDuration={0.9} fillDelay={0.1} stagger={0.045}/></NativeButton>
      <nav ref={navigationRef} className="top-links" aria-label="主要导航">
        <div ref={measureRef} className="overflow-measure" aria-hidden="true" inert>{navigation.map(({ label, icon: Icon }) => <span className="top-link" key={label}><Icon size={18}/><span>{label}</span></span>)}</div>
        <NavigationIndicator {...navigationActive}/>
        {navigation.slice(0, visibleCount).map(({ to, label, icon: Icon }) => <NavLink key={to} end={to === "/"} to={to} className={({ isActive }) => cn("nav-link top-link", isActive && "active")}><Icon size={18} strokeWidth={1.55}/><span>{label}</span></NavLink>)}
        {hiddenNavigation.length > 0 && <DropdownMenu><DropdownMenuTrigger asChild><button className={cn("top-link overflow-trigger", hiddenCurrent && "active")} aria-label="更多导航">{hiddenCurrent ? hiddenCurrent.label : "更多"}<span aria-hidden="true">▾</span></button></DropdownMenuTrigger><DropdownMenuContent align="end">{hiddenNavigation.map(({ to, label, icon: Icon }) => <DropdownMenuItem key={to} asChild><NavLink to={to} end={to === "/"}><Icon size={16}/>{label}{(location.pathname === to || (to !== "/" && location.pathname.startsWith(`${to}/`))) && <span aria-hidden="true">✓</span>}</NavLink></DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>}
      </nav>
      <div className="top-actions">
        <NotificationCenter/>
        <nav className="utility-navigation" aria-label="管理工具">{utilities.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} title={label} aria-label={label} className={({ isActive }) => cn("utility-link", isActive && "active")}><Icon size={17} strokeWidth={1.5}/></NavLink>)}</nav>
      </div>
    </header>

    <section className="app-workspace">
      <main className="content-stage"><motion.div key={location.pathname} className="page-content" initial={reducedMotion || detailRoute ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ type: "spring", stiffness: 380, damping: 34 }}>{children}</motion.div></main>
    </section>
    <GradualBlur target="page" position="bottom" height="44px" strength={1.4} divCount={4} curve="bezier" tint="var(--shell-bottom-tint)" zIndex={25} className="viewport-bottom-blur"/>
  </div>
}
