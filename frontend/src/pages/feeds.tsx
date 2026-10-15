import { MIKAN_BASE_URL } from "@/lib/mikan"
import { AddSubscriptionButton } from "@/components/add-subscription-button"
import { EditSubscriptionDialog } from "@/components/edit-subscription-dialog"
import { FeedClearlogo } from "@/components/feed-clearlogo"
import { NativeButton } from "@/components/ui/button"
import { useState, type FormEvent } from "react"
import { ContextMenu } from "radix-ui"
import { useNavigate } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, ImageOff, LoaderCircle, MoreHorizontal, Pencil, RefreshCw, RadioTower, ScanSearch, Trash2 } from "lucide-react"
import { api, ApiError, type Show, type Feed, type FeedInspection, type TmdbCandidate, type TmdbMetadata } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Field } from "@/components/field"
import { TagInput } from "@/components/ui/tag-input"
import { Input } from "@/components/ui/input"
import { PageHeading } from "@/components/page-heading"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useToast } from "@/components/ui/toast"
import { Skeleton } from "@/components/ui/skeleton"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

/** RSS 源的创建、编辑、列表、手动刷新和删除界面。 */
export function FeedsPage() {
  const client = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Feed | null>(null)
  const [deleting, setDeleting] = useState<Feed | null>(null)
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const [season, setSeason] = useState("")
  const [excludedKeywords, setExcludedKeywords] = useState<string[]>(["720"])
  const [kind, setKind] = useState<"mikan" | "standard">("mikan")
  const [candidates, setCandidates] = useState<TmdbCandidate[]>([])
  const [selected, setSelected] = useState<TmdbCandidate | null>(null)
  const [metadata, setMetadata] = useState<TmdbMetadata | null>(null)
  function redirectToSettings(error: Error) {
    if (!(error instanceof ApiError) || !["/settings#tmdb", "/settings#downloader"].includes(error.settingsPath ?? "")) return false
    toast("添加订阅前请完善设置", { description: error.message, tone: "warning" })
    setOpen(false)
    navigate(error.settingsPath!)
    return true
  }
  const prerequisites = useMutation({
    mutationFn: () => api<{ message: string }>("/feeds/prerequisites", { method: "POST" }),
    onSuccess: () => { create.reset(); setOpen(true) },
    onError: (error) => { if (!redirectToSettings(error)) toast("无法检查订阅配置", { description: error.message, tone: "error" }) },
  })
  const feeds = useQuery({ queryKey: ["feeds"], queryFn: () => api<Feed[]>("/feeds") })
  const shows = useQuery({ queryKey: ["shows"], queryFn: () => api<Show[]>("/shows") })
  const clearlogos = new Map(shows.data?.filter((show) => show.clearlogo_ready).map((show) => [show.id, show]))
  const create = useMutation({
    mutationFn: () => api<Feed>("/feeds", { method: "POST", body: JSON.stringify({ name, url, kind, excluded_keywords: excludedKeywords, season: season === "" ? null : Number(season), active: true, refresh_interval_minutes: 5, tmdb: selected ? { tmdb_id: selected.tmdb_id, media_type: selected.media_type } : null }) }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["feeds"] })
      void client.invalidateQueries({ queryKey: ["dashboard"] })
      void client.invalidateQueries({ queryKey: ["shows"] })
      setExcludedKeywords(["720"]); setOpen(false); setName(""); setUrl(""); setSeason(""); setCandidates([]); setSelected(null); setMetadata(null)
    },
    onError: (error) => { redirectToSettings(error) },
  })
  const tmdbSearch = useMutation({
    mutationFn: (query: string) => api<TmdbCandidate[]>("/tmdb/search", { method: "POST", body: JSON.stringify({ query }) }),
    onSuccess: (results) => {
      setCandidates(results)
      setSelected(null)
      setMetadata(null)
      if (!results.length) toast("未找到 TMDB 条目", { description: "可以调整番剧名称后重新搜索。", tone: "warning" })
    },
    onError: (error) => toast("TMDB 搜索失败", { description: error.message, tone: "error" }),
  })
  const tmdbDetail = useMutation({
    mutationFn: (candidate: TmdbCandidate) => api<TmdbMetadata>(`/tmdb/${candidate.media_type}/${candidate.tmdb_id}`),
    onSuccess: (result) => setMetadata(result),
    onError: (error) => toast("TMDB 刮削失败", { description: error.message, tone: "error" }),
  })
  const inspect = useMutation({
    mutationFn: () => api<FeedInspection>("/feeds/inspect", { method: "POST", body: JSON.stringify({ url }) }),
    onSuccess: (result) => {
      setName(result.name)
      setKind(result.kind)
      setCandidates([])
      setSelected(null)
      setMetadata(null)
      tmdbSearch.mutate(result.name)
      toast("RSS 解析完成", { description: `识别为“${result.name}”，包含 ${result.entries} 个发布条目。` })
    },
    onError: (error) => toast("RSS 解析失败", { description: error.message, tone: "error" }),
  })
  const refresh = useMutation({
    mutationFn: (id: number) => api<{ created: number; duplicates: number }>(`/feeds/${id}/refresh`, { method: "POST" }),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: ["feeds"] })
      void client.invalidateQueries({ queryKey: ["dashboard"] })
      void client.invalidateQueries({ queryKey: ["shows"] })
      toast("RSS 刷新完成", { description: `新增 ${result.created} 条，忽略 ${result.duplicates} 条重复发布。` })
    },
    onError: (error) => toast("RSS 刷新失败", { description: error.message, tone: "error" }),
  })
  const remove = useMutation({
    mutationFn: (id: number) => api(`/feeds/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["feeds"] })
      void client.invalidateQueries({ queryKey: ["dashboard"] })
      void client.invalidateQueries({ queryKey: ["shows"] })
      toast("RSS 订阅已删除")
      setDeleting(null)
    },
    onError: (error) => toast("删除订阅失败", { description: error.message, tone: "error" }),
  })
  function submit(event: FormEvent) { event.preventDefault(); if (!create.isPending) create.mutate() }
  function chooseCandidate(candidate: TmdbCandidate) {
    setSelected(candidate)
    setMetadata(null)
    tmdbDetail.mutate(candidate)
  }

  return <>
    <PageHeading eyebrow="Sources" title="RSS 订阅" description="管理 Mikan 和兼容 RSS / Atom 的发布源。相同条目会按 GUID、链接和内容指纹去重。" action={
      <Dialog open={open} onOpenChange={next => { if (next) { if (!prerequisites.isPending) prerequisites.mutate() } else setOpen(false) }}>
        <DialogTrigger asChild><AddSubscriptionButton pending={prerequisites.isPending}/></DialogTrigger>
        <DialogContent>
          <DialogHeader><DialogTitle>添加 RSS 源</DialogTitle><DialogDescription>保存后自动关闭，后台刮削完成后会通知你。</DialogDescription></DialogHeader>
          <form onSubmit={submit} className="grid gap-4">
            <Field label={<span className="inline-flex items-center gap-2">RSS 地址<a href={MIKAN_BASE_URL} target="_blank" rel="noopener noreferrer" className="text-xs font-normal text-[var(--accent)] hover:underline" aria-label="打开蜜柑计划（新标签页）">蜜柑计划 ↗</a></span>} hint="后端会读取频道 <title>，并自动清理 Mikan Project 前缀。"><div className="flex flex-col gap-2 sm:flex-row"><Input type="url" value={url} onChange={(event) => { setUrl(event.target.value); setCandidates([]); setSelected(null); setMetadata(null); tmdbSearch.reset() }} placeholder={`${MIKAN_BASE_URL}/RSS/...`} required/><Button type="button" variant="secondary" onClick={() => inspect.mutate()} disabled={!url || inspect.isPending}><ScanSearch size={15} className={inspect.isPending ? "animate-pulse" : ""}/>{inspect.isPending ? "解析中…" : "解析 RSS"}</Button></div></Field>
            <Field label="番剧名称" hint="解析完成后会自动搜索 TMDB；修改名称后可再次搜索。"><div className="flex flex-col gap-2 sm:flex-row"><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="留空时由后端自动解析"/><Button type="button" variant="secondary" onClick={() => tmdbSearch.mutate(name)} disabled={!name || tmdbSearch.isPending}><ScanSearch size={15}/>{tmdbSearch.isPending ? "搜索中…" : "搜索 TMDB"}</Button></div></Field>
            {(tmdbSearch.isPending || tmdbSearch.isSuccess || candidates.length > 0) && <Field label="匹配 TMDB 条目" hint="选择正确的作品，Mooncell 会保存 TMDB ID 并刮削媒体信息。">
              <div className="max-h-80 space-y-2 overflow-y-auto rounded-[2px] border border-[var(--border)] bg-[var(--surface)] p-2">
                {tmdbSearch.isPending ? <div className="flex min-h-28 items-center justify-center gap-2 text-sm text-[var(--muted)]"><LoaderCircle className="animate-spin" size={17}/>正在搜索 TMDB…</div> : !candidates.length ? <div className="grid min-h-28 place-items-center px-4 text-center text-sm text-[var(--muted)]">没有找到匹配条目，请调整番剧名称后重新搜索。</div> : candidates.map((candidate) => {
                  const active = selected?.tmdb_id === candidate.tmdb_id && selected.media_type === candidate.media_type
                  return <NativeButton key={`${candidate.media_type}-${candidate.tmdb_id}`} type="button" onClick={() => chooseCandidate(candidate)} className={`flex w-full gap-3 rounded-[2px] border p-2.5 text-left transition ${active ? "border-[var(--accent)] bg-[var(--accent-soft)] ring-2 ring-[var(--accent)]/60" : "border-transparent hover:border-[var(--border)] "}`}>
                    <div className="grid h-[84px] w-14 shrink-0 place-items-center overflow-hidden rounded-[2px] bg-[var(--surface-raised)] text-[var(--muted)]">{candidate.poster_url ? <img src={candidate.poster_url} alt="" className="h-full w-full object-cover"/> : <ImageOff size={18}/>}</div>
                    <div className="min-w-0 flex-1"><div className="flex items-start justify-between gap-2"><div><p className="font-semibold text-[var(--ink)]">{candidate.title}</p>{candidate.original_title && <p className="truncate text-[13px] text-[var(--muted)]">{candidate.original_title}</p>}</div>{active && <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[var(--accent)] text-[var(--on-accent)]"><Check size={14}/></span>}</div><p className="mt-1 text-xs text-[var(--muted)]">{candidate.media_type === "tv" ? "电视节目" : "电影"} · TMDB #{candidate.tmdb_id}{candidate.release_date ? ` · ${candidate.release_date}` : ""}</p>{candidate.overview && <p className="mt-1.5 line-clamp-2 text-[13px] leading-5 text-[var(--muted)]">{candidate.overview}</p>}</div>
                  </NativeButton>
                })}
              </div>
            </Field>}
            {selected && <div className="rounded-[2px] border border-[var(--accent)] bg-[var(--accent-soft)] px-3 py-2.5 text-sm text-[var(--ink)]">{tmdbDetail.isPending ? <span className="flex items-center gap-2"><LoaderCircle className="animate-spin" size={15}/>正在刮削 TMDB #{selected.tmdb_id}…</span> : metadata ? <span className="flex items-center gap-2"><Check className="text-[var(--accent)]" size={15}/>已刮削：{metadata.title}{metadata.episode_count ? ` · ${metadata.episode_count} 集` : ""}{metadata.rating ? ` · ${metadata.rating} 分` : ""}</span> : "等待刮削结果"}</div>}
            <Field label="排除关键词" hint="标题包含任意关键词的发布将被跳过，不区分大小写。默认排除 720（如 720p）；清空则不过滤。"><TagInput value={excludedKeywords} onChange={setExcludedKeywords} label="排除关键词" disabled={create.isPending}/></Field>
            <Field label="季度" hint="留空自动识别；填写后优先使用此季度，0 表示特别篇。"><Input type="number" min={0} max={99} step={1} value={season} onChange={(event) => setSeason(event.target.value)} placeholder="例如：1"/></Field>
            <Field label="类型"><Select value={kind} onValueChange={(value) => setKind(value as typeof kind)}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent><SelectItem value="mikan">Mikan Project</SelectItem><SelectItem value="standard">标准 RSS / Atom</SelectItem></SelectContent></Select></Field>
            {tmdbSearch.error && <p className="rounded-[2px] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">{tmdbSearch.error.message}</p>}
            {tmdbDetail.error && <p className="rounded-[2px] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">{tmdbDetail.error.message}</p>}
            {create.error && <p className="rounded-[2px] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">{create.error.message}</p>}
            <DialogFooter><Button type="button" variant="secondary" onClick={() => setOpen(false)}>取消</Button><Button disabled={create.isPending || !metadata}>{create.isPending ? "保存中…" : "保存订阅"}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    }/>
    <Card>
      <CardHeader><div><CardTitle>全部订阅</CardTitle><CardDescription>{feeds.data?.length ?? 0} 个发布源</CardDescription></div></CardHeader>
      <CardContent className="p-0">
        {feeds.isPending ? <div role="status" aria-label="正在加载 RSS 订阅" aria-busy="true" className="grid gap-6 p-5">{[0, 1, 2].map(index => <div key={index} className="grid gap-3"><Skeleton className="h-4 w-1/3"/><Skeleton className="h-3 w-2/3"/></div>)}</div> : feeds.isError ? <div role="alert" className="p-5 text-sm text-[var(--danger)]">订阅读取失败：{feeds.error.message}<Button variant="secondary" size="sm" className="ml-3" onClick={() => void feeds.refetch()}>重试</Button></div> : !feeds.data?.length ? <div className="grid min-h-64 place-items-center p-5"><div className="text-center"><RadioTower className="mx-auto text-[var(--muted)]" size={30}/><p className="mt-3 text-sm font-medium">还没有 RSS 订阅</p><p className="mt-1 text-[13px] text-[var(--muted)]">先从 Mikan 复制一个番剧 RSS 地址。</p></div></div> : <div className="feed-list">{feeds.data.map((feed) => <ContextMenu.Root key={feed.id}>
          <ContextMenu.Trigger asChild>
            <div tabIndex={0} aria-label={`${feed.name}，右键打开订阅菜单`} className="feed-card grid gap-4 px-5 py-4 transition-colors duration-200 hover:bg-white/[.03]">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2"><p className="truncate text-sm font-semibold">{feed.name}</p><Badge>{feed.kind}</Badge>{!feed.active && <Badge>已停用</Badge>}</div>
                <p className="mt-1 truncate text-[13px] text-[var(--muted)]">{feed.url}</p>
                {feed.last_error && <p className="mt-1 text-xs text-[var(--danger)]">{feed.last_error}</p>}
              </div>
              <div className="feed-card-clearlogo" aria-hidden="true">{clearlogos.has(feed.id) && <FeedClearlogo show={clearlogos.get(feed.id)!}/>}</div>
              <div className="feed-card-status">
                <Badge tone={feed.connection_status === "healthy" ? "success" : feed.connection_status === "error" ? "danger" : "neutral"}>{feed.connection_status === "healthy" ? "正常" : feed.connection_status === "error" ? "异常" : "未检查"}</Badge>
                <div className="flex shrink-0 items-center gap-2">
                  <Button size="sm" variant="secondary" icon={Pencil} onClick={() => setEditing(feed)} aria-label={`${feed.name}：编辑订阅`}>编辑</Button>
                  <Button size="sm" variant="secondary" icon={RefreshCw} iconMotion="refresh" pending={refresh.isPending && refresh.variables === feed.id} pendingLabel="刷新中" onClick={() => refresh.mutate(feed.id)} disabled={refresh.isPending} aria-label={`${feed.name}：刷新订阅`}>刷新</Button>
                  <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label={`${feed.name}：更多操作`}><MoreHorizontal size={16}/></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => setEditing(feed)}><Pencil size={15}/>编辑订阅</DropdownMenuItem><DropdownMenuItem disabled={remove.isPending} onSelect={() => setDeleting(feed)} className="text-[var(--danger)]"><Trash2 size={15}/>删除订阅</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
                </div>
              </div>
            </div>
          </ContextMenu.Trigger>
          <ContextMenu.Portal>
            <ContextMenu.Content className="z-[70] min-w-36 rounded border border-[var(--border)] bg-[var(--surface)] p-1 shadow-xl">
              <ContextMenu.Item onSelect={() => setEditing(feed)} className="flex cursor-default select-none items-center gap-2 rounded-sm px-3 py-2 text-sm outline-none data-[highlighted]:bg-[var(--accent-soft)]"><Pencil size={15}/>编辑订阅</ContextMenu.Item>
              <ContextMenu.Item disabled={remove.isPending} onSelect={() => setDeleting(feed)} className="flex cursor-default select-none items-center gap-2 rounded-sm px-3 py-2 text-sm text-[var(--danger)] outline-none data-[highlighted]:bg-[var(--danger-soft)] data-[disabled]:opacity-50"><Trash2 size={15}/>删除订阅</ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Portal>
        </ContextMenu.Root>)}</div>}
      </CardContent>
    </Card>
    {editing && <EditSubscriptionDialog key={editing.id} feed={editing} onClose={() => setEditing(null)}/>}
    <Dialog open={deleting !== null} onOpenChange={open => { if (!open && !remove.isPending) setDeleting(null) }}><DialogContent className="max-w-md"><DialogHeader><DialogTitle>删除订阅</DialogTitle><DialogDescription>确定删除“{deleting?.name}”吗？删除后将停止从此 RSS 源发现新发布。</DialogDescription></DialogHeader><DialogFooter><Button variant="secondary" disabled={remove.isPending} onClick={() => setDeleting(null)}>取消</Button><Button variant="danger" icon={Trash2} pending={remove.isPending} pendingLabel="删除中…" onClick={() => deleting && remove.mutate(deleting.id)}>删除订阅</Button></DialogFooter></DialogContent></Dialog>
  </>
}
