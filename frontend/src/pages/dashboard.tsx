import { useCallback, useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { Pause, Play } from "lucide-react"
import { animate, motion, useMotionValue, useReducedMotion } from "motion/react"
import { useQuery } from "@tanstack/react-query"
import { api, type Show } from "@/lib/api"
import { artworkUrl, posterUrl } from "@/lib/show-artwork"
import { Button } from "@/components/ui/button"
import { DashboardHeading, DashboardLoading, DashboardRecent } from "@/components/dashboard-loading"
import { AccordionGallery } from "@/components/accordion-gallery"
import { AddSubscriptionButton } from "@/components/add-subscription-button"
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

export function DashboardPage() {
  const showsQuery = useQuery({ queryKey: ["shows"], queryFn: () => api<Show[]>("/shows") })
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
  // Only redraw when the available subscriptions change, not on carousel updates or metadata refreshes.
  const showIds = (showsQuery.data ?? []).map(show => show.id).sort((a, b) => a - b).join(",")
  const galleryIds = useMemo(() => {
    const ids = showIds ? showIds.split(",").map(Number) : []
    for (let index = ids.length - 1; index > 0; index--) {
      const randomIndex = Math.floor(Math.random() * (index + 1))
      const current = ids[index]
      ids[index] = ids[randomIndex]
      ids[randomIndex] = current
    }
    return ids.slice(0, 4)
  }, [showIds])
  const allShows = [...(showsQuery.data ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)
  const shows = galleryIds.map(id => showsQuery.data?.find(show => show.id === id)).filter((show): show is Show => show !== undefined)
  const selectedIndex = Math.min(activeIndex, Math.max(0, shows.length - 1))
  const next = useCallback(() => setActiveIndex(current => (current + 1) % Math.max(1, shows.length)), [shows.length])
  if (showsQuery.isPending) return <DashboardLoading/>
  return <>
    <DashboardHeading count={allShows.length}/>
    {showsQuery.isError ? <div role="alert" className="p-8 text-[var(--danger)]">订阅加载失败：{showsQuery.error.message}<Button variant="secondary" size="sm" className="ml-3" onClick={() => void showsQuery.refetch()}>重试</Button></div> : !shows.length ? <section className="grid min-h-64 place-items-center border border-[var(--border)] bg-[var(--surface)]/20 p-8 text-center"><div><h2 className="text-xl">从第一部番剧开始</h2><p className="mb-6 mt-3 text-sm text-[var(--muted)]">添加 RSS 订阅后，这里会显示你的番剧与发布信息。</p><AddSubscriptionButton to="/feeds"/></div></section> : <>
      <section aria-label="番剧画廊"
        onFocusCapture={() => setFocused(true)}
        onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false) }}
      >
        <AccordionGallery activeIndex={selectedIndex} onActiveChange={setActiveIndex} orientation={compact ? "vertical" : "horizontal"} height={compact ? 620 : 460} items={shows.map(show => ({
          id: show.id,
          image: show.fanart_ready ? artworkUrl(show, "fanart") : posterUrl(show),
          label: show.name,
          link: `/shows/${show.id}`,
          caption: <span className="ag-panel__details"><span>已发现 {show.discovered_items} 条发布</span><span>{show.media_type === "movie" ? "电影" : show.episode_count != null ? `TMDB 共 ${show.episode_count} 集` : "总集数未知"}</span></span>,
          footer: shows.length > 1 && !reducedMotion && !compact ? <Countdown key={show.id} paused={focused || paused || pageHidden} onNext={next}/> : undefined,
        }))}/>
      </section>
      {shows.length > 1 && !reducedMotion && !compact && <div className="continue-controls"><Button variant="ghost" size="sm" icon={paused ? Play : Pause} aria-pressed={paused} onClick={() => setPaused(value => !value)}>{paused ? "继续自动切换" : "暂停自动切换"}</Button></div>}
      <DashboardRecent>{allShows.slice(0, 5).map(show => <Link className="recent-item" key={show.id} to={`/shows/${show.id}`}>
          <span className="recent-image">{show.poster_ready || show.poster_url ? <img src={posterUrl(show)} alt="" loading="lazy"/> : <ShowCover title={show.name}/>}</span>
          <strong>{show.name}</strong><small>已发现 {show.discovered_items} 条发布</small>
        </Link>)}</DashboardRecent>
    </>}
  </>
}
