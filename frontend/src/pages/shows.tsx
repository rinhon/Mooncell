import { ActionButton } from "@/components/ui/action-button"
import { ArtworkUpload } from "@/components/artwork-upload"
import { Upload } from "lucide-react"
import { ShowsHeader, ShowsLoading, type ShowsView } from "@/components/shows-loading"
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react"
import { motion, useReducedMotion } from "motion/react"
import TargetCursor from "@/components/target-cursor"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { FolderOpen, ImageOff, LoaderCircle, MoreHorizontal, RefreshCw, Star } from "lucide-react"
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom"
import { api, type Show } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { BlurFade } from "@/components/ui/blur-fade"
import { GradualBlur } from "@/components/ui/gradual-blur"
import { ShowCover } from "@/components/show-cover"
import { Card, CardContent } from "@/components/ui/card"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useToast } from "@/components/ui/toast"

import { artworkUrl, posterUrl, showReturnState } from "@/lib/show-artwork"

function useCardColumns() {
  const getColumns = () => window.matchMedia("(min-width: 1280px)").matches ? 3
    : window.matchMedia("(min-width: 640px)").matches ? 2 : 1
  const [columns, setColumns] = useState(getColumns)
  useEffect(() => {
    const breakpoints = [window.matchMedia("(min-width: 640px)"), window.matchMedia("(min-width: 1280px)")]
    const update = () => setColumns(getColumns())
    breakpoints.forEach(breakpoint => breakpoint.addEventListener("change", update))
    update()
    return () => breakpoints.forEach(breakpoint => breakpoint.removeEventListener("change", update))
  }, [])
  return columns
}

function useArtworkReady(shows: Show[] | undefined) {
  const imageKey = JSON.stringify([...new Set((shows ?? []).flatMap((show) => [
    show.fanart_ready ? artworkUrl(show, "fanart") : null,
    show.poster_ready ? artworkUrl(show, "poster") : show.poster_url,
    show.clearlogo_ready ? artworkUrl(show, "clearlogo") : null,
  ].filter((url): url is string => Boolean(url))))])
  const [readyKey, setReadyKey] = useState<string | null>(null)
  useEffect(() => {
    if (!shows) return
    let cancelled = false
    const cleanup: (() => void)[] = []
    const urls: string[] = JSON.parse(imageKey)
    void Promise.all(urls.map((url) => new Promise<void>((resolve) => {
      const image = new Image()
      const finish = () => {
        window.clearTimeout(timeout)
        image.onload = null
        image.onerror = null
        resolve()
      }
      // 单张图片请求挂起时也要允许用户进入页面。
      const timeout = window.setTimeout(finish, 15000)
      image.onload = () => { void image.decode().catch(() => {}).then(finish) }
      image.onerror = finish
      cleanup.push(finish)
      image.src = url
    }))).then(() => { if (!cancelled) setReadyKey(imageKey) })
    return () => { cancelled = true; cleanup.forEach((finish) => finish()) }
  }, [imageKey, shows])
  return imageKey === "[]" || readyKey === imageKey
}

function TmdbLink({ show }: { show: Show }) {
  const label = <Badge>TMDB #{show.tmdb_id}</Badge>
  const href = show.tmdb_url
  if (!href || !/^https?:\/\//i.test(href)) return label
  return <a href={href} target="_blank" rel="noopener noreferrer" aria-label={`在新标签页打开 ${show.name} 的 TMDB 页面`} data-cursor-label="跳转" className="rounded-sm transition-opacity hover:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-2">{label}</a>
}

function DiscoveredItemsButton({ show, onClick }: { show: Show; onClick: () => void }) {
  if (show.discovered_items === 0) return <span className="font-semibold">0 条</span>
  return <button type="button" onClick={onClick} className="rounded-sm font-semibold text-[var(--accent)] underline decoration-current/30 underline-offset-4 transition hover:decoration-current focus-visible:outline-2 focus-visible:outline-offset-2" aria-label={`查看 ${show.name} 的 ${show.discovered_items} 条 RSS 标题`}>{show.discovered_items} 条</button>
}

/** 将 RSS 订阅、TMDB 元数据和本地三图组合成真实番剧媒体库。 */
export function ShowsPage() {
  const cursorScopeRef = useRef<HTMLDivElement>(null)
  const reducedMotion = useReducedMotion()
  const cardColumns = useCardColumns()
  const location = useLocation()
  const navigate = useNavigate()
  const restore = showReturnState(location.state?.restoreShowList)
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState(() => params.get("q") ?? "")
  const [view, setView] = useState<ShowsView>(restore.view ?? "cards")
  const [uploadId, setUploadId] = useState<number | null>(null)
  const [itemsShow, setItemsShow] = useState<Show | null>(null)
  const client = useQueryClient()
  const toast = useToast()
  const showsQuery = useQuery({ queryKey: ["shows"], queryFn: () => api<Show[]>("/shows") })
  const itemTitlesQuery = useQuery({
    queryKey: ["shows", itemsShow?.id, "items"],
    queryFn: () => api<string[]>(`/shows/${itemsShow!.id}/items`),
    enabled: itemsShow !== null,
  })
  const artworkReady = useArtworkReady(showsQuery.data)
  const rescrape = useMutation({
    mutationFn: (id: number) => api<Show>(`/shows/${id}/rescrape`, { method: "POST" }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["shows"] })
      client.invalidateQueries({ queryKey: ["feeds"] })
      client.invalidateQueries({ queryKey: ["notifications"] })
    },
  })
  const openFolder = useMutation({
    mutationFn: (id: number) => api<{ message: string }>(`/shows/${id}/open-folder`, { method: "POST" }),
    onSuccess: (result) => toast(result.message),
    onError: () => toast("无法打开番剧文件夹", { description: "请确认目录已经创建，并查看实时日志。", tone: "error" }),
  })
  const shows = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return (showsQuery.data ?? []).filter((show) =>
      `${show.name}${show.metadata_title ?? ""}`.toLowerCase().includes(normalized),
    )
  }, [query, showsQuery.data, params])

  const restoredScroll = useRef(false)
  useEffect(() => {
    if (showsQuery.data && artworkReady && !restoredScroll.current) {
      restoredScroll.current = true
      window.requestAnimationFrame(() => window.scrollTo(0, restore.scrollY ?? 0))
    }
  }, [showsQuery.data, artworkReady, restore.scrollY])
  useEffect(() => { setQuery(params.get("q") ?? "") }, [params])
  const detailState = () => ({ from: `/shows${query ? `?${new URLSearchParams({ q: query })}` : ""}`, view, scrollY: window.scrollY })
  function openDetail(event: MouseEvent<HTMLAnchorElement>, id: number) {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    const context = detailState()
    navigate(context.from, { replace: true, state: { restoreShowList: context } })
    navigate(`/shows/${id}`, { state: context })
  }
  if (params.has("id")) {
    const legacy = new URLSearchParams(params); const id = legacy.get("id"); legacy.delete("id")
    return <Navigate to={`/shows/${encodeURIComponent(id || "invalid")}`} replace state={{ from: `/shows${legacy.size ? `?${legacy}` : ""}` }}/>
  }

  if (showsQuery.isPending || (!showsQuery.isError && !artworkReady && uploadId === null)) return <ShowsLoading query={query} view={view} filtered={params.has("id")} count={showsQuery.isPending ? undefined : shows.length}/>

  return <div ref={cursorScopeRef} className="shows-cursor-scope">
    {!reducedMotion && uploadId === null && itemsShow === null && <TargetCursor container={cursorScopeRef} targetSelector='.shows-cursor-scope :is(button:not(:disabled):not([aria-disabled="true"]), a[href])' blendMode="difference" cursorColor="var(--ink)" cursorColorOnTarget="var(--accent)" size={28} cornerSize={9} thickness={2} padding={4} hoverDuration={.24} spinDuration={3} showLabel/>}
    {rescrape.isError && <p role="alert" className="mb-4 text-sm text-[var(--danger)]">重新刮削提交失败：{rescrape.error.message}</p>}
    <ArtworkUpload show={showsQuery.data?.find(show => show.id === uploadId) ?? null} onClose={() => setUploadId(null)}/>
    <Dialog open={itemsShow !== null} onOpenChange={(open) => { if (!open) setItemsShow(null) }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{itemsShow?.name ?? "RSS 条目"}</DialogTitle>
          <DialogDescription>RSS 中已发现的原始标题，共 {itemsShow?.discovered_items ?? 0} 条。</DialogDescription>
        </DialogHeader>
        {itemTitlesQuery.isPending && <div role="status" className="flex min-h-32 items-center justify-center gap-2 text-sm text-[var(--muted)]"><LoaderCircle size={16} className="animate-spin"/>正在读取标题…</div>}
        {itemTitlesQuery.isError && <div role="alert" className="rounded-[var(--radius-control)] bg-[var(--danger-soft)] p-4 text-sm text-[var(--danger)]">读取失败：{itemTitlesQuery.error.message}<button type="button" className="ml-2 underline" onClick={() => void itemTitlesQuery.refetch()}>重试</button></div>}
        {itemTitlesQuery.isSuccess && itemTitlesQuery.data.length === 0 && <p className="py-10 text-center text-sm text-[var(--muted)]">暂无 RSS 标题。</p>}
        {itemTitlesQuery.isSuccess && itemTitlesQuery.data.length > 0 && <ul className="max-h-[60vh] divide-y divide-[var(--border-soft)] overflow-y-auto border-y border-[var(--border)]">{itemTitlesQuery.data.map((title, index) => <li key={`${index}-${title}`} className="break-words py-3 text-sm leading-6 text-[var(--ink)]">{title}</li>)}</ul>}
      </DialogContent>
    </Dialog>
    <ShowsHeader query={query} view={view} filtered={params.has("id")} onClear={() => { setQuery(""); setParams(new URLSearchParams()) }} onQueryChange={value => {
      setQuery(value)
      const next = new URLSearchParams(params); next.delete("id"); if (value) next.set("q", value); else next.delete("q"); setParams(next, { replace: true })
    }} onViewChange={setView}/>

    {showsQuery.isError && <Card><CardContent className="p-8 text-center text-sm text-[var(--danger)]">读取番剧失败：{showsQuery.error.message}</CardContent></Card>}
    {!showsQuery.isError && !shows.length && <Card><CardContent className="grid min-h-56 place-items-center p-8 text-center"><div><ImageOff className="mx-auto mb-3 text-[var(--muted)]"/><p className="font-medium">还没有匹配的番剧订阅</p><p className="mt-1 text-sm text-[var(--muted)]">请先在 RSS 订阅页添加并关联 TMDB 条目。</p></div></CardContent></Card>}

    {view === "posters" && shows.length > 0 && <div className="show-poster-grid" aria-label="番剧海报">{shows.map((show, index) => <BlurFade key={show.id} className="min-w-0" delay={(index % 5) * 0.08} duration={0.4} offset={8} inView inViewMargin="0px">
      <motion.div whileHover={reducedMotion ? undefined : { y: -5, scale: 1.015 }} transition={{ type: "spring", stiffness: 400, damping: 30 }} className="transform-gpu">
        <Link to={`/shows/${show.id}`} state={detailState()} onClick={event => openDetail(event, show.id)} aria-label={`查看 ${show.name} 详情`} title={show.name} className="show-poster-tile ring-1 ring-[var(--island-border)] hover:ring-[var(--accent)]/55">
          {posterUrl(show) ? <img src={posterUrl(show)} alt={`${show.name} 海报`} className="size-full object-cover"/> : <ShowCover title={show.name}/>}
          <GradualBlur position="bottom" height="22%" strength={1.6} divCount={3} exponential curve="bezier" tint="var(--poster-blur-tint)"/>
          <span className="show-poster-caption">
            <strong>{show.name}</strong>
            <small>已发现 {show.discovered_items} 条发布</small>
          </span>
        </Link>
      </motion.div>
    </BlurFade>)}</div>}

    {view === "cards" && <div className="show-card-grid" aria-label="番剧卡片">{shows.map((show, index) => <BlurFade key={show.id} className="show-card-reveal min-w-0" delay={(index % cardColumns) * 0.08} duration={0.4} offset={8} inView inViewMargin="0px">
      <motion.div whileHover={reducedMotion ? undefined : { y: -5 }} transition={{ type: "spring", stiffness: 400, damping: 30 }} className="h-full transform-gpu">
      <Card className="group flex h-full min-w-0 flex-col overflow-hidden rounded-[var(--radius-panel)] border-[var(--island-border)] bg-[var(--island-background)] shadow-[var(--island-shadow)] backdrop-blur-xl transition-colors duration-200 hover:border-[var(--accent)]/45">
      <Link to={`/shows/${show.id}`} state={detailState()} onClick={event => openDetail(event, show.id)} className="relative block h-56 shrink-0 overflow-hidden bg-[var(--skeleton)]">
        {show.fanart_ready && <img src={artworkUrl(show, "fanart")} alt="" className="absolute inset-0 size-full object-cover transform-gpu"/>}
        <GradualBlur position="bottom" height="24%" strength={1.8} divCount={3} exponential curve="bezier" tint="var(--card-hero-blur-tint)" className="z-[1]"/>
        <div className="absolute inset-x-4 bottom-4 z-[2] flex items-end gap-4">
          <div className="h-32 w-22 shrink-0 overflow-hidden rounded-[var(--radius-control)] bg-[var(--surface-raised)] shadow-2xl ring-1 ring-white/25">
            {(show.poster_ready || show.poster_url) ? <img src={show.poster_ready ? artworkUrl(show, "poster") : show.poster_url} alt={`${show.name} 海报`} className="size-full object-cover"/> : <ShowCover title={show.name}/>}
          </div>
          <div className="min-w-0 flex-1 pb-1 text-white drop-shadow-[0_2px_10px_rgba(0,0,0,0.65)]">
            {show.clearlogo_ready && <img src={artworkUrl(show, "clearlogo")} alt="" className="mb-3 max-h-12 max-w-48 object-contain object-left drop-shadow"/>}
            <p className="line-clamp-2 text-lg font-semibold leading-tight">{show.name}</p>
            {show.metadata_title && show.metadata_title !== show.name && <p className="mt-1 truncate text-xs text-white/75">{show.metadata_title}</p>}
          </div>
        </div>
      </Link>
      <CardContent className="flex flex-1 flex-col p-5">
        <div className="flex items-center gap-2">{show.tmdb_id && <TmdbLink show={show}/>}{show.rating != null && <span className="flex items-center gap-1 text-xs text-[var(--muted)]"><Star size={13} className="fill-amber-400 text-amber-400"/>{show.rating.toFixed(1)}</span>}<DropdownMenu><DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" pressMotion={false} className="ml-auto" aria-label="更多操作"><MoreHorizontal size={17}/></Button></DropdownMenuTrigger><DropdownMenuContent align="end" animateSize><DropdownMenuItem onSelect={() => setUploadId(show.id)}><Upload size={15}/>上传图片</DropdownMenuItem><DropdownMenuItem disabled={rescrape.isPending && rescrape.variables === show.id} onSelect={() => rescrape.mutate(show.id)}>{rescrape.isPending && rescrape.variables === show.id ? <LoaderCircle size={15} className="animate-spin"/> : <RefreshCw size={15}/>}重新刮削</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div>
        <p className="mt-4 line-clamp-3 min-h-18 whitespace-pre-line break-words text-sm leading-6 text-[var(--muted)]">{show.overview || "暂无剧情简介"}</p>
        <div className="mt-auto pt-4"><div className="grid grid-cols-2 gap-3 rounded-[var(--radius-control)] border border-[var(--border-soft)] bg-[var(--surface)]/35 p-3 text-xs backdrop-blur-sm"><div><p className="text-[var(--muted)]">已发现发布</p><div className="mt-1"><DiscoveredItemsButton show={show} onClick={() => setItemsShow(show)}/></div></div><div><p className="text-[var(--muted)]">TMDB 集数</p><p className="mt-1 font-semibold">{show.episode_count ?? "未知"}</p></div></div></div>
        <ActionButton icon={FolderOpen} emphasis="secondary" className="mt-4 w-full" pending={openFolder.isPending && openFolder.variables === show.id} pendingLabel="打开中…" onClick={() => openFolder.mutate(show.id)}>打开文件夹</ActionButton>
      </CardContent>
      </Card>
      </motion.div>
    </BlurFade>)}</div>}

    {view === "list" && shows.length > 0 && <ul className="show-row-list" aria-label="番剧列表">
      {shows.map((show, index) => <motion.li key={show.id}
        initial={reducedMotion ? false : { opacity: 0, y: 18 }}
        whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.15 }}
        transition={reducedMotion ? { duration: 0 } : { type: "spring", stiffness: 380, damping: 32, delay: Math.min(index, 6) * 0.06 }}>
        <Card className="show-row-card">
          <Link to={`/shows/${show.id}`} state={detailState()} onClick={event => openDetail(event, show.id)} aria-label={`查看 ${show.name} 详情`} className="show-row-poster">
            {(show.poster_ready || show.poster_url) ? <img src={show.poster_ready ? artworkUrl(show, "poster") : show.poster_url} alt="" className="size-full object-cover"/> : <ShowCover title={show.name}/>}
          </Link>
          <div className="min-w-0">
            <h2 className="line-clamp-2 break-words text-base font-semibold leading-snug" title={show.name}><Link to={`/shows/${show.id}`} state={detailState()} onClick={event => openDetail(event, show.id)}>{show.name}</Link></h2>
            {show.metadata_title !== show.name && <p className="mt-1 truncate text-[13px] text-[var(--muted)]">{show.metadata_title || "未关联元数据"}</p>}
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-[var(--muted)]">
              {show.tmdb_id && <TmdbLink show={show}/>}
              {show.rating != null && <span className="flex items-center gap-1"><Star size={13} className="fill-amber-400 text-amber-400"/>{show.rating.toFixed(1)}</span>}
              <span>TMDB 集数 {show.episode_count ?? "未知"}</span>
            </div>
          </div>
          <div className="show-row-footer">
            <div className="show-row-discovered"><p className="text-xs text-[var(--muted)]">已发现发布</p><div className="mt-1 text-sm"><DiscoveredItemsButton show={show} onClick={() => setItemsShow(show)}/></div></div>
            <div className="show-row-actions">
              <ActionButton icon={FolderOpen} emphasis="secondary" size="sm" pending={openFolder.isPending && openFolder.variables === show.id} pendingLabel="打开中…" onClick={() => openFolder.mutate(show.id)}>文件夹</ActionButton>
              <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon" variant="ghost" pressMotion={false} aria-label="更多操作"><MoreHorizontal size={17}/></Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end" animateSize>
                  <DropdownMenuItem onSelect={() => setUploadId(show.id)}><Upload size={15}/>上传图片</DropdownMenuItem>
                  <DropdownMenuItem disabled={rescrape.isPending && rescrape.variables === show.id} onSelect={() => rescrape.mutate(show.id)}>{rescrape.isPending && rescrape.variables === show.id ? <LoaderCircle size={15} className="animate-spin"/> : <RefreshCw size={15}/>}重新刮削</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </Card>
      </motion.li>)}
    </ul>}
  </div>
}
