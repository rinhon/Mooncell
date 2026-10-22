import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom"
import { lazy, Suspense, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { LoaderCircle, MoonStar } from "lucide-react"
import { api, type AuthStatus } from "@/lib/api"
import { useEvents } from "@/hooks/use-events"
import { AuthScreen } from "@/components/auth-screen"
import { AppShell } from "@/components/app-shell"
import { Skeleton } from "@/components/ui/skeleton"
import { CalendarLoading } from "@/components/calendar-loading"
import { FeedsLoading } from "@/components/feeds-loading"
import { ShowDetailLoading } from "@/components/show-detail-loading"
import { ShowsLoading } from "@/components/shows-loading"
import { DashboardLoading } from "@/components/dashboard-loading"
import { DownloadsLoading } from "@/components/downloads-loading"
import Grainient from "@/components/grainient"
import { useTheme } from "@/lib/theme"

const DashboardPage = lazy(() => import("@/pages/dashboard").then(module => ({ default: module.DashboardPage })))
const FeedsPage = lazy(() => import("@/pages/feeds").then(module => ({ default: module.FeedsPage })))
const ReviewPage = lazy(() => import("@/pages/review").then(module => ({ default: module.ReviewPage })))
const SettingsPage = lazy(() => import("@/pages/settings").then(module => ({ default: module.SettingsPage })))
const ShowDetailPage = lazy(() => import("@/pages/show-detail").then(module => ({ default: module.ShowDetailPage })))
const ShowsPage = lazy(() => import("@/pages/shows").then(module => ({ default: module.ShowsPage })))
const DownloadsPage = lazy(() => import("@/pages/downloads").then(module => ({ default: module.DownloadsPage })))
const OrganizerPage = lazy(() => import("@/pages/organizer").then(module => ({ default: module.OrganizerPage })))
const CalendarPage = lazy(() => import("@/pages/calendar").then(module => ({ default: module.CalendarPage })))
const LogsPage = lazy(() => import("@/pages/logs").then(module => ({ default: module.LogsPage })))
const WatchPage = lazy(() => import("@/pages/watch").then(module => ({ default: module.WatchPage })))

function ApplicationFrame({ children }: { children: ReactNode }) {
  const { palette } = useTheme()
  const location = useLocation()
  if (location.pathname.startsWith("/watch/")) return <>{children}</>
  return <><div className="ambient-background" aria-hidden="true"><Grainient color1={palette.gradient[0]} color2={palette.gradient[1]} color3={palette.gradient[2]} timeSpeed={0.3} warpStrength={1} warpAmplitude={18} rotationAmount={300} blendSoftness={0.22} grainAmount={0.018} contrast={1.05} saturation={1}/></div><AppShell>{children}</AppShell></>
}

function PageSkeleton() {
  return <div role="status" aria-label="正在加载页面" aria-busy="true" className="grid gap-6"><span className="sr-only">正在加载页面…</span><Skeleton className="h-14 w-48"/><Skeleton className="h-4 w-3/4"/><Skeleton className="h-72 w-full"/></div>
}

/** 根据初始化和登录状态选择认证界面或管理后台。 */
export default function App() {
  const demoAuth = import.meta.env.DEV && import.meta.env.VITE_DEMO_AUTH === "true"
  const auth = useQuery({ queryKey: ["auth"], queryFn: () => api<AuthStatus>("/auth/status"), retry: false, enabled: !demoAuth })
  useEvents(demoAuth || Boolean(auth.data?.authenticated))
  if (!demoAuth && auth.isLoading) return <div className="grid min-h-screen place-items-center"><div className="text-center"><span className="mx-auto grid size-12 place-items-center rounded-[var(--radius-control)] bg-[var(--surface)] text-[var(--accent)]"><MoonStar/></span><LoaderCircle className="mx-auto mt-4 animate-spin text-[var(--muted)]" size={18}/></div></div>
  if (!demoAuth && auth.isError) return <div className="grid min-h-screen place-items-center p-6 text-center"><div><p className="font-semibold">无法连接 Mooncell 后端</p><p className="mt-2 text-sm text-[var(--muted)]">请确认 Mooncell 后端已启动，然后刷新页面。</p></div></div>
  if (!demoAuth && !auth.data?.authenticated) return <AuthScreen initialized={Boolean(auth.data?.initialized)}/>
  return <BrowserRouter><ApplicationFrame><Suspense fallback={<PageSkeleton/>}><Routes>
    <Route path="/watch/:mediaId" element={<WatchPage/>}/>
    <Route path="/" element={<Suspense fallback={<DashboardLoading/>}><DashboardPage/></Suspense>}/>
    <Route path="/shows" element={<Suspense fallback={<ShowsLoading/>}><ShowsPage/></Suspense>}/>
    <Route path="/shows/:sourceId" element={<Suspense fallback={<ShowDetailLoading/>}><ShowDetailPage/></Suspense>}/>
    <Route path="/downloads" element={<Suspense fallback={<DownloadsLoading/>}><DownloadsPage/></Suspense>}/>
    <Route path="/organizer" element={<OrganizerPage/>}/>
    <Route path="/calendar" element={<Suspense fallback={<CalendarLoading/>}><CalendarPage/></Suspense>}/>
    <Route path="/feeds" element={<Suspense fallback={<FeedsLoading/>}><FeedsPage/></Suspense>}/>
    <Route path="/parser" element={<Navigate to="/settings" replace/>}/>
    <Route path="/downloaders" element={<Navigate to="/settings" replace/>}/>
    <Route path="/review" element={<ReviewPage/>}/>
    <Route path="/settings" element={<SettingsPage/>}/>
    <Route path="/logs" element={<LogsPage/>}/>
  </Routes></Suspense></ApplicationFrame></BrowserRouter>
}
