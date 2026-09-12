import { NativeButton } from "@/components/ui/button"
import { useEffect, useRef, useState, type CSSProperties } from "react"
import { useNavigate } from "react-router-dom"
import { Download, ImageOff } from "lucide-react"
import { useQuery } from "@tanstack/react-query"
import { api, type Show } from "@/lib/api"
import { ActionButton } from "@/components/ui/action-button"
import { AddSubscriptionButton } from "@/components/add-subscription-button"
import { PageHeading } from "@/components/page-heading"

/** 总览页使用参考图的“主任务 + 连续行 + 最近项目”结构。 */
export function DashboardPage() {
  const showsQuery = useQuery({ queryKey: ["shows"], queryFn: () => api<Show[]>("/shows") })
  const navigate = useNavigate()
  const [activeIndex, setActiveIndex] = useState(0)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const elapsed = useRef(0)
  const [autoplayProgress, setAutoplayProgress] = useState(0)
  const allShows = [...(showsQuery.data ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)
  const shows = allShows.slice(0, 4)
  const selectedIndex = Math.min(activeIndex, Math.max(0, shows.length - 1))
  useEffect(() => {
    elapsed.current = 0
    setAutoplayProgress(0)
  }, [activeIndex, shows.length])
  useEffect(() => {
    if (hovered || focused || shows.length < 2) return
    let previous = performance.now()
    let frame: number
    const tick = (now: number) => {
      elapsed.current += Math.min(now - previous, 100)
      previous = now
      setAutoplayProgress(Math.min(elapsed.current / 5000, 1))
      if (elapsed.current >= 5000) {
        setActiveIndex(current => (current + 1) % shows.length)
        return
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [activeIndex, hovered, focused, shows.length])
  return <>
    <PageHeading eyebrow={`${allShows.length} 个番剧订阅`} title="订阅总览" description="查看最近订阅的番剧、已发现的发布和下载任务。" action={<AddSubscriptionButton to="/feeds"/>}/>
    {showsQuery.isPending ? <div role="status" className="grid min-h-64 place-items-center border border-[var(--border)] motion-safe:animate-pulse">正在加载订阅…</div> : showsQuery.isError ? <div role="alert" className="p-8 text-[var(--danger)]">订阅加载失败：{showsQuery.error.message}<button className="ml-3 underline" onClick={() => void showsQuery.refetch()}>重试</button></div> : !shows.length ? <section className="grid min-h-64 place-items-center border border-[var(--border)] bg-[var(--surface)]/20 p-8 text-center"><div><h2 className="text-xl">从第一部番剧开始</h2><p className="mb-6 mt-3 text-sm text-[var(--muted)]">添加 RSS 订阅后，这里会显示你的番剧与发布信息。</p><AddSubscriptionButton to="/feeds"/></div></section> : <>
    <section className="continue-board" aria-label="正在处理"
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false) }}
      style={{
      "--continue-height": `calc(clamp(245px, 20vw, 360px) + ${(shows.length - 1) * 118}px)`,
      "--continue-tracks": shows.map((_, index) => index === selectedIndex ? "minmax(0, clamp(245px, 20vw, 360px))" : "minmax(0, 118px)").join(" "),
    } as CSSProperties}>
      {shows.map((show, index) => {
        const active = index === selectedIndex
        return <article className={active ? "continue-feature" : "continue-row"} key={show.id}
          onPointerMove={(event) => { if (event.pointerType === "mouse" && window.matchMedia("(min-width: 721px)").matches) setActiveIndex(index) }}
          onFocus={() => { if (window.matchMedia("(min-width: 721px)").matches) setActiveIndex(index) }}>
          <span className="selection-dot" aria-hidden="true"/>
          {active && shows.length > 1 && <div className="continue-countdown" role="progressbar" aria-label="自动切换倒计时" aria-valuemin={0} aria-valuemax={5} aria-valuenow={Math.floor(autoplayProgress * 5)} aria-valuetext={hovered || focused ? "自动切换已暂停" : `${Math.ceil((1 - autoplayProgress) * 5)} 秒后切换`}><span style={{ transform: `scaleX(${autoplayProgress})` }}/></div>}
          <div className="continue-art">{show.fanart_ready || show.poster_ready || show.poster_url ? <img src={show.fanart_ready ? `/api/v1/shows/${show.id}/artwork/fanart` : show.poster_ready ? `/api/v1/shows/${show.id}/artwork/poster` : show.poster_url} alt=""/> : <div className="grid h-full min-h-28 place-items-center text-[var(--muted)]"><ImageOff size={36}/></div>}</div>
          <div className="continue-copy">
            <h2>{show.name}</h2>
            <p>已发现 {show.discovered_items} 条发布</p>
            <div className="episode-progress"><span className="!text-left !w-auto">{show.episode_count != null ? `TMDB 共 ${show.episode_count} 集` : "总集数未知"}</span></div>
            <ActionButton icon={Download} pendingLabel="加载中…" onClick={() => navigate(`/downloads?${new URLSearchParams({ q: show.name })}`)}>查看下载</ActionButton>
          </div>
        </article>
      })}
    </section>

    <section className="recent-section">
      <div className="recent-heading"><p>最近添加 <span>/ {Math.min(allShows.length, 5)}</span></p></div>
      <div className="recent-grid">
        {allShows.slice(0, 5).map((show) => <NativeButton className="recent-item" key={show.id} onClick={() => navigate("/shows")}>
          <span className="recent-image">{show.poster_ready || show.poster_url ? <img src={show.poster_ready ? `/api/v1/shows/${show.id}/artwork/poster` : show.poster_url} alt=""/> : <span className="grid h-full place-items-center text-[var(--muted)]"><ImageOff size={24}/></span>}</span>
          <strong>{show.name}</strong>
          <small>已发现 {show.discovered_items} 条发布</small>
        </NativeButton>)}
      </div>
    </section>
    </>}
  </>
}
