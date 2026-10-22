import { useCallback, useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion } from "motion/react"
import { useQuery } from "@tanstack/react-query"
import { api, type Show } from "@/lib/api"
import { artworkUrl, posterUrl } from "@/lib/show-artwork"
import { Button } from "@/components/ui/button"
import { DashboardHeading, DashboardLoading, DashboardRecent } from "@/components/dashboard-loading"
import { AccordionGallery } from "@/components/accordion-gallery"
import { AddSubscriptionButton } from "@/components/add-subscription-button"
import { ShowCover } from "@/components/show-cover"
import { BlurFade } from "@/components/ui/blur-fade"
import { FadeInImage } from "@/components/ui/fade-in-image"
import { GradualBlur } from "@/components/ui/gradual-blur"

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
  return <AnimatePresence mode="wait">
    {showsQuery.isPending ? <motion.div key="loading" initial={{ opacity: 1 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reducedMotion ? 0 : .14 }}><DashboardLoading/></motion.div> : <motion.div key="content" initial={false} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reducedMotion ? 0 : .14 }}>
    <BlurFade duration={.4} offset={10} direction="up" blur="4px"><DashboardHeading count={allShows.length}/></BlurFade>
    {showsQuery.isError ? <BlurFade delay={.08} duration={.45} direction="up" offset={12} blur="4px"><div role="alert" className="p-8 text-[var(--danger)]">订阅加载失败：{showsQuery.error.message}<Button variant="secondary" size="sm" className="ml-3" onClick={() => void showsQuery.refetch()}>重试</Button></div></BlurFade> : !shows.length ? <BlurFade delay={.08} duration={.45} direction="up" offset={12} blur="4px"><section className="grid min-h-64 place-items-center rounded-[var(--radius-panel)] border border-[var(--island-border)] bg-[var(--island-background)] p-8 text-center backdrop-blur-xl"><div><h2 className="text-xl">从第一部番剧开始</h2><p className="mb-6 mt-3 text-sm text-[var(--muted)]">添加 RSS 订阅后，这里会显示你的番剧与发布信息。</p><AddSubscriptionButton to="/feeds"/></div></section></BlurFade> : <>
      <BlurFade delay={.08} duration={.55} direction="up" offset={14} blur="4px">
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
          footer: shows.length > 1 && !reducedMotion && !compact ? <Countdown key={show.id} paused={focused || pageHidden} onNext={next}/> : undefined,
        }))}/>
      </section>
      </BlurFade>
      <BlurFade delay={.18} duration={.5} direction="up" offset={14} blur="4px">
      <DashboardRecent>{allShows.slice(0, 5).map(show => <motion.div key={show.id} whileHover={reducedMotion ? undefined : { y: -5, scale: 1.015 }} transition={{ type: "spring", stiffness: 400, damping: 30 }} className="min-w-0 transform-gpu"><Link className="recent-item" to={`/shows/${show.id}`}>
          <span className="recent-image">
            {posterUrl(show) ? <FadeInImage src={posterUrl(show)!} alt="" loading="lazy"/> : <ShowCover title={show.name}/>}
            <GradualBlur position="bottom" height="22%" strength={1.6} divCount={3} exponential curve="bezier" tint="var(--poster-blur-tint)" className="recent-item-blur"/>
            <span className="recent-item-caption">
              <strong>{show.name}</strong>
              <small>已发现 {show.discovered_items} 条发布</small>
            </span>
          </span>
        </Link></motion.div>)}</DashboardRecent>
      </BlurFade>
    </>}
    </motion.div>}
  </AnimatePresence>
}
