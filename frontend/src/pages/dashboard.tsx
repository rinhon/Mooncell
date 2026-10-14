import { useCallback, useEffect, useState, type CSSProperties } from "react"
import { Link, useNavigate } from "react-router-dom"
import { Download, Pause, Play } from "lucide-react"
import { animate, motion, useMotionValue, useReducedMotion } from "motion/react"
import { useQuery } from "@tanstack/react-query"
import { api, type Show } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { ActionButton } from "@/components/ui/action-button"
import { AddSubscriptionButton } from "@/components/add-subscription-button"
import { PageHeading } from "@/components/page-heading"
import { ShowCover } from "@/components/show-cover"

function Countdown({ paused, onNext }: { paused: boolean; onNext: () => void }) {
  const progress = useMotionValue(0)
  const [seconds, setSeconds] = useState(5)
  useEffect(() => {
    if (paused) return
    const animation = animate(progress, 1, { duration: (1 - progress.get()) * 5, ease: "linear", onComplete: onNext })
    // Only this accessible label renders once a second; the bar bypasses React.
    const timer = window.setInterval(() => setSeconds(Math.ceil((1 - progress.get()) * 5)), 1000)
    return () => { animation.stop(); window.clearInterval(timer) }
  }, [paused, onNext, progress])
  return <div className="continue-countdown" role="progressbar" aria-label="自动切换倒计时" aria-valuemin={0} aria-valuemax={5} aria-valuenow={5 - seconds} aria-valuetext={paused ? "自动切换已暂停" : `${seconds} 秒后切换`}><motion.span style={{ scaleX: progress }}/></div>
}

function DashboardSkeleton() {
  return <div role="status" aria-label="正在加载番剧订阅" aria-busy="true"><span className="sr-only">正在加载番剧订阅…</span>
    <div className="border border-[var(--border)]" aria-hidden="true">{[0, 1, 2, 3].map(index => <div key={index} className={`grid grid-cols-[44%_1fr] border-b border-[var(--border-soft)] last:border-0 ${index ? "h-[118px]" : "h-[245px]"}`}><Skeleton className="h-full"/><div className="grid content-center gap-3 p-6"><Skeleton className="h-6 w-3/4"/><Skeleton className="h-3 w-1/2"/><Skeleton className="h-3 w-2/5"/></div></div>)}</div>
    <div className="recent-grid mt-8" aria-hidden="true">{[0, 1, 2, 3, 4].map(index => <div key={index}><Skeleton className="aspect-[2/3]"/><Skeleton className="mx-auto mt-3 h-3 w-3/4"/></div>)}</div>
  </div>
}

export function DashboardPage() {
  const showsQuery = useQuery({ queryKey: ["shows"], queryFn: () => api<Show[]>("/shows") })
  const navigate = useNavigate()
  const [activeIndex, setActiveIndex] = useState(0)
  const [focused, setFocused] = useState(false)
  const [paused, setPaused] = useState(false)
  const [compact, setCompact] = useState(() => window.matchMedia("(max-width: 720px)").matches)
  const [pageHidden, setPageHidden] = useState(() => document.hidden)
  const reducedMotion = useReducedMotion()
  useEffect(() => {
    const media = window.matchMedia("(max-width: 720px)")
    const changeSize = () => setCompact(media.matches)
    const changeVisibility = () => setPageHidden(document.hidden)
    media.addEventListener("change", changeSize)
    document.addEventListener("visibilitychange", changeVisibility)
    return () => { media.removeEventListener("change", changeSize); document.removeEventListener("visibilitychange", changeVisibility) }
  }, [])
  const allShows = [...(showsQuery.data ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)
  const shows = allShows.slice(0, 4)
  const selectedIndex = Math.min(activeIndex, Math.max(0, shows.length - 1))
  const next = useCallback(() => setActiveIndex(current => (current + 1) % Math.max(1, shows.length)), [shows.length])
  return <>
    <PageHeading eyebrow="OVERVIEW" title="首页" description={`已订阅 ${allShows.length} 部番剧，查看最近发布和下载任务。`} action={<AddSubscriptionButton to="/feeds"/>}/>
    {showsQuery.isPending ? <DashboardSkeleton/> : showsQuery.isError ? <div role="alert" className="p-8 text-[var(--danger)]">订阅加载失败：{showsQuery.error.message}<Button variant="secondary" size="sm" className="ml-3" onClick={() => void showsQuery.refetch()}>重试</Button></div> : !shows.length ? <section className="grid min-h-64 place-items-center border border-[var(--border)] bg-[var(--surface)]/20 p-8 text-center"><div><h2 className="text-xl">从第一部番剧开始</h2><p className="mb-6 mt-3 text-sm text-[var(--muted)]">添加 RSS 订阅后，这里会显示你的番剧与发布信息。</p><AddSubscriptionButton to="/feeds"/></div></section> : <>
      <section className="continue-board" aria-label="最近订阅"
        onFocusCapture={() => setFocused(true)}
        onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false) }}
        style={{
          "--continue-height": `calc(clamp(245px, 20vw, 360px) + ${(shows.length - 1) * 118}px)`,
          "--continue-tracks": shows.map((_, index) => index === selectedIndex ? "minmax(0, clamp(245px, 20vw, 360px))" : "minmax(0, 118px)").join(" "),
        } as CSSProperties}>
        {shows.map((show, index) => {
          const active = index === selectedIndex
          return <article className={active ? "continue-feature" : "continue-row"} key={show.id}
            onPointerMove={event => { if (event.pointerType === "mouse" && window.matchMedia("(min-width: 721px)").matches) setActiveIndex(index) }}
            onFocus={() => { if (window.matchMedia("(min-width: 721px)").matches) setActiveIndex(index) }}>
            <span className="selection-dot" aria-hidden="true"/>
            {active && shows.length > 1 && !reducedMotion && !compact && <Countdown key={show.id} paused={focused || paused || pageHidden} onNext={next}/>}
            <div className="continue-art">{show.fanart_ready || show.poster_ready || show.poster_url ? <img src={show.fanart_ready ? `/api/v1/shows/${show.id}/artwork/fanart` : show.poster_ready ? `/api/v1/shows/${show.id}/artwork/poster` : show.poster_url} alt=""/> : <ShowCover title={show.name}/>}</div>
            <div className="continue-copy">
              <h2><button type="button" aria-expanded={active} aria-label={`展开${show.name}`} onClick={() => setActiveIndex(index)}>{show.name}</button></h2>
              <p>已发现 {show.discovered_items} 条发布</p>
              <div className="episode-progress"><span>{show.episode_count != null ? `TMDB 共 ${show.episode_count} 集` : "总集数未知"}</span></div>
              <ActionButton icon={Download} pendingLabel="加载中…" onClick={() => navigate(`/downloads?${new URLSearchParams({ q: show.name })}`)}>查看下载</ActionButton>
            </div>
          </article>
        })}
      </section>
      {shows.length > 1 && !reducedMotion && !compact && <div className="continue-controls"><Button variant="ghost" size="sm" icon={paused ? Play : Pause} aria-pressed={paused} onClick={() => setPaused(value => !value)}>{paused ? "继续自动切换" : "暂停自动切换"}</Button></div>}
      <section className="recent-section">
        <div className="recent-heading"><p>最近添加</p><Link to="/shows">查看全部</Link></div>
        <div className="recent-grid">{allShows.slice(0, 5).map(show => <Link className="recent-item" key={show.id} to={`/shows?${new URLSearchParams({ id: String(show.id) })}`}>
          <span className="recent-image">{show.poster_ready || show.poster_url ? <img src={show.poster_ready ? `/api/v1/shows/${show.id}/artwork/poster` : show.poster_url} alt="" loading="lazy"/> : <ShowCover title={show.name}/>}</span>
          <strong>{show.name}</strong><small>已发现 {show.discovered_items} 条发布</small>
        </Link>)}</div>
      </section>
    </>}
  </>
}
