import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { LoaderCircle, MoonStar } from "lucide-react"
import { api, type AuthStatus } from "@/lib/api"
import { useEvents } from "@/hooks/use-events"
import { AuthScreen } from "@/components/auth-screen"
import { AppShell } from "@/components/app-shell"
import { DashboardPage } from "@/pages/dashboard"
import { FeedsPage } from "@/pages/feeds"

import { ReviewPage } from "@/pages/review"
import { SettingsPage } from "@/pages/settings"
import { ShowsPage } from "@/pages/shows"
import { DownloadsPage } from "@/pages/downloads"
import { OrganizerPage } from "@/pages/organizer"
import { CalendarPage } from "@/pages/calendar"
import { LogsPage } from "@/pages/logs"

/** 根据初始化和登录状态选择认证界面或管理后台。 */
export default function App(){const demoAuth=import.meta.env.DEV&&import.meta.env.VITE_DEMO_AUTH==="true";const auth=useQuery({queryKey:["auth"],queryFn:()=>api<AuthStatus>("/auth/status"),retry:false,enabled:!demoAuth});useEvents(demoAuth||Boolean(auth.data?.authenticated));if(!demoAuth&&auth.isLoading)return <div className="grid min-h-screen place-items-center"><div className="text-center"><span className="mx-auto grid size-12 place-items-center rounded-2xl bg-zinc-950 text-[var(--accent)]"><MoonStar/></span><LoaderCircle className="mx-auto mt-4 animate-spin text-[var(--muted)]" size={18}/></div></div>;if(!demoAuth&&auth.isError)return <div className="grid min-h-screen place-items-center p-6 text-center"><div><p className="font-semibold">无法连接 Mooncell 后端</p><p className="mt-2 text-sm text-[var(--muted)]">请确认 FastAPI 服务运行在 8000 端口。</p></div></div>;if(!demoAuth&&!auth.data?.authenticated)return <AuthScreen initialized={Boolean(auth.data?.initialized)}/>;return <BrowserRouter><AppShell><Routes><Route path="/" element={<DashboardPage/>}/><Route path="/shows" element={<ShowsPage/>}/><Route path="/downloads" element={<DownloadsPage/>}/><Route path="/organizer" element={<OrganizerPage/>}/><Route path="/calendar" element={<CalendarPage/>}/><Route path="/feeds" element={<FeedsPage/>}/><Route path="/parser" element={<Navigate to="/settings#parser" replace/>}/><Route path="/downloaders" element={<Navigate to="/settings" replace/>}/><Route path="/review" element={<ReviewPage/>}/><Route path="/settings" element={<SettingsPage/>}/><Route path="/logs" element={<LogsPage/>}/></Routes></AppShell></BrowserRouter>}
