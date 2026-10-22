import {
  CalendarDays,
  Download,
  FileCheck2,
  LayoutDashboard,
  ListFilter,
  RadioTower,
  Settings2,
  Tv2,
  type LucideIcon,
} from "lucide-react"

export type NavigationItem = {
  to: string
  label: string
  icon: LucideIcon
}

/** 桌面顶栏与窄屏抽屉共用，详情子路由由 NavLink 自动匹配。 */
export const navigation: NavigationItem[] = [
  { to: "/", label: "首页", icon: LayoutDashboard },
  { to: "/shows", label: "番剧", icon: Tv2 },
  { to: "/feeds", label: "订阅", icon: RadioTower },
  { to: "/downloads", label: "下载", icon: Download },
  { to: "/calendar", label: "日历", icon: CalendarDays },
]

export const utilityNavigation: NavigationItem[] = [
  { to: "/review", label: "审核", icon: ListFilter },
  { to: "/logs", label: "日志", icon: FileCheck2 },
  { to: "/settings", label: "设置", icon: Settings2 },
]
