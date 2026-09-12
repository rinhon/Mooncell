import { ActionButton } from "@/components/ui/action-button"
import { ArtworkUpload } from "@/components/artwork-upload"
import { Upload } from "lucide-react"
import { AddSubscriptionButton } from "@/components/add-subscription-button"
import { NativeButton } from "@/components/ui/button"
import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { FolderOpen, Grid2X2, ImageOff, List, LoaderCircle, MoreHorizontal, RefreshCw, Search, Star } from "lucide-react"
import { Link, useSearchParams } from "react-router-dom"
import { api, type Show } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { PageHeading } from "@/components/page-heading"
import { useToast } from "@/components/ui/toast"

const artworkUrl = (show: Show, kind: "poster" | "fanart" | "clearlogo") =>
  `/api/v1/shows/${show.id}/artwork/${kind}?v=${encodeURIComponent(show.artwork_version ?? "")}`

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

function ShowsSkeleton() {
  return <div role="status" aria-label="正在加载番剧订阅" aria-busy="true">
    <span className="sr-only">正在加载番剧数据和图片…</span>
    <div aria-hidden="true" className="motion-safe:animate-pulse">
      <div className="mb-4 flex min-h-[94px] items-end justify-between gap-6"><div className="grid gap-3"><div className="h-3 w-24 bg-black/10"/><div className="h-14 w-64 bg-black/10"/><div className="h-4 w-72 max-w-full bg-black/5"/></div><div className="hidden h-10 w-[136px] shrink-0 bg-black/10 sm:block"/></div>
      <div className="mb-5 h-[66px] border border-[var(--border)] bg-black/5"/>
      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }, (_, index) => <div key={index} className="overflow-hidden rounded-[2px] border border-[var(--border)]">
        <div className="relative h-52 bg-black/10"><div className="absolute bottom-4 left-4 h-32 w-22 bg-[var(--surface)]/30"/><div className="absolute bottom-5 left-30 right-4 h-6 bg-[var(--surface)]/30"/></div>
        <div className="grid gap-4 p-5"><div className="h-5 w-28 bg-black/10"/><div className="grid gap-2"><div className="h-3 w-full bg-black/5"/><div className="h-3 w-3/4 bg-black/5"/></div><div className="h-16 bg-black/5"/><div className="h-10 bg-black/10"/></div>
      </div>)}</div>
    </div>
  </div>
}

function TmdbLink({ show }: { show: Show }) {
  const label = <Badge>TMDB #{show.tmdb_id}</Badge>
  const href = show.tmdb_url
  if (!href || !/^https?:\/\//i.test(href)) return label
  return <a href={href} target="_blank" rel="noopener noreferrer" aria-label={`在新标签页打开 ${show.name} 的 TMDB 页面`} title="在新标签页打开 TMDB" className="rounded-sm transition-opacity hover:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-2">{label}</a>
}

function DiscoveredItemsButton({ show, onClick }: { show: Show; onClick: () => void }) {
  if (show.discovered_items === 0) return <span className="font-semibold">0 条</span>
  return <button type="button" onClick={onClick} className="rounded-sm font-semibold text-[var(--accent)] underline decoration-current/30 underline-offset-4 transition hover:decoration-current focus-visible:outline-2 focus-visible:outline-offset-2" aria-label={`查看 ${show.name} 的 ${show.discovered_items} 条 RSS 标题`}>{show.discovered_items} 条</button>
}

/** 将 RSS 订阅、TMDB 元数据和本地三图组合成真实番剧媒体库。 */
export function ShowsPage() {
  const [params] = useSearchParams()
  const [query, setQuery] = useState(() => params.get("q") ?? "")
  const [view, setView] = useState<"cards" | "table">("cards")
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
    onSuccess: (show) => {
      client.invalidateQueries({ queryKey: ["shows"] })
      client.invalidateQueries({ queryKey: ["feeds"] })
      const title = show.artwork_status === "completed"
        ? "三张图片已重新刮削"
        : show.artwork_status === "failed" ? "刮削失败，可稍后重试" : "刮削完成，但图片不完整"
      toast(title, { description: show.artwork_status === "failed" ? "详细原因请查看实时日志。" : "poster、fanart、clearlogo 已保存到番剧目录。", tone: show.artwork_status === "failed" ? "error" : undefined })
    },
    onError: (error) => toast("重新刮削失败", { description: error.message, tone: "error" }),
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
  }, [query, showsQuery.data])

  if (showsQuery.isPending || (!showsQuery.isError && !artworkReady && uploadId === null)) return <ShowsSkeleton/>

  return <>
    <ArtworkUpload show={showsQuery.data?.find(show => show.id === uploadId) ?? null} onClose={() => setUploadId(null)}/>
    <Dialog open={itemsShow !== null} onOpenChange={(open) => { if (!open) setItemsShow(null) }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{itemsShow?.name ?? "RSS 条目"}</DialogTitle>
          <DialogDescription>RSS 中已发现的原始标题，共 {itemsShow?.discovered_items ?? 0} 条。</DialogDescription>
        </DialogHeader>
        {itemTitlesQuery.isPending && <div role="status" className="flex min-h-32 items-center justify-center gap-2 text-sm text-[var(--muted)]"><LoaderCircle size={16} className="animate-spin"/>正在读取标题…</div>}
        {itemTitlesQuery.isError && <div role="alert" className="rounded-xl bg-red-500/10 p-4 text-sm text-[var(--danger)]">读取失败：{itemTitlesQuery.error.message}<button type="button" className="ml-2 underline" onClick={() => void itemTitlesQuery.refetch()}>重试</button></div>}
        {itemTitlesQuery.isSuccess && itemTitlesQuery.data.length === 0 && <p className="py-10 text-center text-sm text-[var(--muted)]">暂无 RSS 标题。</p>}
        {itemTitlesQuery.isSuccess && itemTitlesQuery.data.length > 0 && <ul className="max-h-[60vh] divide-y divide-zinc-200 overflow-y-auto border-y border-[var(--border)]">{itemTitlesQuery.data.map((title, index) => <li key={`${index}-${title}`} className="break-words py-3 text-sm leading-6 text-[var(--ink)]">{title}</li>)}</ul>}
      </DialogContent>
    </Dialog>
    <PageHeading eyebrow="Subscriptions" title="番剧订阅" description="订阅数据来自数据库；海报、背景图和透明 Logo 保存在对应番剧目录。" action={<AddSubscriptionButton to="/feeds"/>}/>
    <div className="mb-5 flex items-center gap-3 rounded-[2px] border border-[var(--border)] bg-[var(--paper)] p-3">
      <div className="relative flex-1"><Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" size={16}/><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索订阅名称或 TMDB 名称" className="pl-9"/></div>
      <div className="flex shrink-0 rounded-[2px] border border-[var(--border-soft)] bg-black/[.03] p-1"><NativeButton onClick={() => setView("cards")} className={`grid size-8 place-items-center rounded-[2px] transition-colors ${view === "cards" ? "bg-black/[.08] text-[var(--ink)]" : "text-[var(--muted)] "}`} aria-label="卡片视图"><Grid2X2 size={15}/></NativeButton><NativeButton onClick={() => setView("table")} className={`grid size-8 place-items-center rounded-[2px] transition-colors ${view === "table" ? "bg-black/[.08] text-[var(--ink)]" : "text-[var(--muted)] "}`} aria-label="列表视图"><List size={15}/></NativeButton></div>
    </div>

    {showsQuery.isError && <Card><CardContent className="p-8 text-center text-sm text-[var(--danger)]">读取番剧失败：{showsQuery.error.message}</CardContent></Card>}
    {!showsQuery.isError && !shows.length && <Card><CardContent className="grid min-h-56 place-items-center p-8 text-center"><div><ImageOff className="mx-auto mb-3 text-[var(--muted)]"/><p className="font-medium">还没有匹配的番剧订阅</p><p className="mt-1 text-sm text-[var(--muted)]">请先在 RSS 订阅页添加并关联 TMDB 条目。</p></div></CardContent></Card>}

    {view === "cards" && <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">{shows.map((show) => <Card key={show.id} className="group min-w-0 overflow-hidden transition duration-200  hover:shadow-lg">
      <div className="relative h-52 overflow-hidden bg-[#222825]">
        {show.fanart_ready && <img src={artworkUrl(show, "fanart")} alt="" className="absolute inset-0 size-full object-cover transition duration-500 group-hover:scale-105"/>}
        <div className="absolute inset-0 bg-black/25"/>
        <div className="absolute inset-x-4 bottom-4 flex items-end gap-4">
          <div className="h-32 w-22 shrink-0 overflow-hidden rounded-xl bg-[var(--surface-raised)] shadow-xl ring-1 ring-white/30">
            {(show.poster_ready || show.poster_url) ? <img src={show.poster_ready ? artworkUrl(show, "poster") : show.poster_url} alt={`${show.name} 海报`} className="size-full object-cover"/> : <div className="grid size-full place-items-center"><ImageOff className="text-[var(--muted)]"/></div>}
          </div>
          <div className="min-w-0 flex-1 pb-1 text-white">
            {show.clearlogo_ready && <img src={artworkUrl(show, "clearlogo")} alt="" className="mb-3 max-h-12 max-w-48 object-contain object-left drop-shadow"/>}
            <p className="line-clamp-2 text-lg font-semibold leading-tight">{show.name}</p>
            {show.metadata_title && show.metadata_title !== show.name && <p className="mt-1 truncate text-xs text-white/70">{show.metadata_title}</p>}
          </div>
        </div>
      </div>
      <CardContent className="p-5">
        <div className="flex items-center gap-2">{show.tmdb_id && <TmdbLink show={show}/>}{show.rating != null && <span className="flex items-center gap-1 text-xs text-[var(--muted)]"><Star size={13} className="fill-amber-400 text-amber-400"/>{show.rating.toFixed(1)}</span>}<DropdownMenu><DropdownMenuTrigger asChild><Button size="icon" variant="ghost" className="ml-auto size-8" aria-label="更多操作"><MoreHorizontal size={17}/></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => setUploadId(show.id)}><Upload size={15}/>上传图片</DropdownMenuItem><DropdownMenuItem disabled={rescrape.isPending && rescrape.variables === show.id} onSelect={() => rescrape.mutate(show.id)}>{rescrape.isPending && rescrape.variables === show.id ? <LoaderCircle size={15} className="animate-spin"/> : <RefreshCw size={15}/>}重新刮削</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div>
        <p className="mt-4 line-clamp-2 min-h-10 text-sm leading-5 text-[var(--muted)]">{show.overview || "暂无剧情简介"}</p>
        <div className="mt-4 grid grid-cols-2 gap-3 rounded-xl bg-[var(--surface)]/20 p-3 text-xs ring-1 ring-[var(--border)]"><div><p className="text-[var(--muted)]">已发现发布</p><div className="mt-1"><DiscoveredItemsButton show={show} onClick={() => setItemsShow(show)}/></div></div><div><p className="text-[var(--muted)]">TMDB 集数</p><p className="mt-1 font-semibold">{show.episode_count ?? "未知"}</p></div></div>
        <ActionButton icon={FolderOpen} className="folder-action mt-4 w-full" pending={openFolder.isPending && openFolder.variables === show.id} pendingLabel="打开中…" onClick={() => openFolder.mutate(show.id)}>打开文件夹</ActionButton>
      </CardContent>
    </Card>)}</div>}

    {view === "table" && shows.length > 0 && <Card><CardContent className="overflow-x-auto p-0"><table className="w-full min-w-[760px] text-left text-sm"><thead className="border-b border-[var(--border)] text-xs text-[var(--muted)]"><tr><th className="p-4 font-medium">番剧</th><th className="p-4 font-medium">TMDB</th><th className="p-4 font-medium">已发现</th><th className="p-4"></th></tr></thead><tbody>{shows.map((show) => <tr key={show.id} className="border-b border-[var(--border)] transition "><td className="p-4"><div className="flex items-center gap-3"><div className="h-14 w-10 shrink-0 overflow-hidden rounded-md bg-[var(--surface-raised)]">{(show.poster_ready || show.poster_url) ? <img src={show.poster_ready ? artworkUrl(show, "poster") : show.poster_url} className="size-full object-cover" alt=""/> : null}</div><div className="min-w-0"><p className="max-w-80 truncate font-medium">{show.name}</p><p className="mt-1 max-w-80 truncate text-xs text-[var(--muted)]">{show.metadata_title ?? "未关联元数据"}</p></div></div></td><td className="p-4 text-xs text-[var(--muted)]">{show.tmdb_id ? <TmdbLink show={show}/> : "—"}</td><td className="p-4"><DiscoveredItemsButton show={show} onClick={() => setItemsShow(show)}/></td><td className="p-4 text-right"><div className="flex justify-end gap-2"><ActionButton icon={FolderOpen} className="folder-action folder-action-compact" pending={openFolder.isPending && openFolder.variables === show.id} pendingLabel="打开中…" onClick={() => openFolder.mutate(show.id)}>文件夹</ActionButton><DropdownMenu><DropdownMenuTrigger asChild><Button size="icon" variant="ghost" aria-label="更多操作"><MoreHorizontal size={17}/></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => setUploadId(show.id)}><Upload size={15}/>上传图片</DropdownMenuItem><DropdownMenuItem onSelect={() => rescrape.mutate(show.id)}><RefreshCw size={15}/>重新刮削</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div></td></tr>)}</tbody></table></CardContent></Card>}
  </>
}
