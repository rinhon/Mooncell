import { ArrowLeft } from "lucide-react"
import { Link, useLocation } from "react-router-dom"
import { MultiStepLoader } from "@/components/ui/multi-step-loader"

const LOADING_STATES = [
  { text: "读取视频信息" },
  { text: "建立播放连接" },
  { text: "准备视频流" },
  { text: "缓冲画面，即将开始" },
]

export function PlaybackLoading({
  loading = true,
  step = 0,
  backTo,
  title,
  subtitle,
}: {
  loading?: boolean
  step?: number
  backTo?: string
  title?: string
  subtitle?: string
}) {
  const { state } = useLocation()
  const returnTo = backTo ?? (typeof state?.sourceId === "number" ? `/shows/${state.sourceId}` : "/shows")
  const heading = title ?? (typeof state?.showTitle === "string" ? state.showTitle : "准备播放")
  return (
    <MultiStepLoader loading={loading} loadingStates={LOADING_STATES} value={step} loop={false}>
      <header className="absolute inset-x-0 top-0 flex items-center gap-4 px-4 pt-[max(20px,env(safe-area-inset-top))] sm:px-10 sm:pt-8">
        <Link
          to={returnTo}
          className="grid size-11 shrink-0 place-items-center rounded-full text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#8ce8ad]"
          aria-label="取消加载，返回番剧"
          title="返回番剧"
        >
          <ArrowLeft size={23} aria-hidden="true" />
        </Link>
        <div className="min-w-0">
          <h1 className="truncate text-base font-medium sm:text-xl">{heading}</h1>
          {subtitle && <p className="mt-1 truncate text-xs text-white/45 sm:text-sm">{subtitle}</p>}
        </div>
      </header>
      <p className="absolute inset-x-6 bottom-[max(32px,env(safe-area-inset-bottom))] text-center text-xs tracking-wide text-white/35">
        正在为你准备画面
      </p>
    </MultiStepLoader>
  )
}
