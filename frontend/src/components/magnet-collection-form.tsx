import { useEffect, useState, type FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, ImageOff, LoaderCircle, ScanSearch } from "lucide-react"
import { api, type Feed, type TmdbCandidate, type TmdbMetadata } from "@/lib/api"
import { Field } from "@/components/field"
import { Button, NativeButton } from "@/components/ui/button"
import { DialogFooter } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { useToast } from "@/components/ui/toast"

type CollectionFile = { name: string; size: number; episode: number | null; kind: "video" | "extra" | "attachment" }
type Preview = { status: "pending" | "ready"; info_hash: string; raw_title?: string; name?: string; season?: number; size?: number; files?: CollectionFile[] }

export function MagnetCollectionForm({ onClose }: { onClose: () => void }) {
  const client = useQueryClient()
  const toast = useToast()
  const [magnet, setMagnet] = useState("")
  const [requested, setRequested] = useState<{ magnet: string; started: number } | null>(null)
  const [name, setName] = useState("")
  const [season, setSeason] = useState("1")
  const [searchTerm, setSearchTerm] = useState("")
  const [selected, setSelected] = useState<TmdbCandidate | null>(null)
  const preview = useQuery({
    queryKey: ["collection-preview", requested],
    enabled: !!requested,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: ({ signal }) => {
      if (Date.now() - requested!.started > 120_000) throw new Error("暂时未找到可用的元数据节点，请稍后重新解析。")
      return api<Preview>("/collections/inspect", { method: "POST", signal, body: JSON.stringify({ magnet: requested!.magnet }) })
    },
    refetchInterval: query => query.state.status === "error" || query.state.data?.status === "ready" ? false : 2000,
  })
  const ready = !!requested && preview.data?.status === "ready"
  const parsing = !!requested && !ready && !preview.isError
  useEffect(() => {
    if (preview.data?.status === "ready") {
      setName(preview.data.name ?? "")
      setSeason(String(preview.data.season ?? 1))
      setSearchTerm(preview.data.name ?? "")
      setSelected(null)
    }
  }, [preview.data])
  const candidates = useQuery({
    queryKey: ["collection-tmdb-search", searchTerm], enabled: ready && !!searchTerm,
    queryFn: ({ signal }) => api<TmdbCandidate[]>("/tmdb/search", { method: "POST", signal, body: JSON.stringify({ query: searchTerm }) }),
    select: results => results.filter(candidate => candidate.media_type === "tv"),
  })
  const detail = useQuery({
    queryKey: ["collection-tmdb-detail", selected?.tmdb_id], enabled: !!selected,
    queryFn: ({ signal }) => api<TmdbMetadata>(`/tmdb/tv/${selected!.tmdb_id}`, { signal }),
  })
  const save = useMutation({
    mutationFn: () => api<Feed>("/collections", { method: "POST", body: JSON.stringify({
      magnet: requested!.magnet, name: name.trim(), season: Number(season),
      tmdb: { tmdb_id: selected!.tmdb_id, media_type: "tv" },
    }) }),
    onSuccess: () => {
      for (const key of ["feeds", "shows", "downloads", "dashboard", "notifications"]) void client.invalidateQueries({ queryKey: [key] })
      toast("合集已添加", { description: "后台将刮削作品信息，并下载整理正片和匹配字幕。" })
      onClose()
    },
  })
  function submit(event: FormEvent) {
    event.preventDefault()
    if (ready && selected && detail.data && name.trim() && season !== "" && !save.isPending) save.mutate()
  }
  function resetMagnet(value: string) {
    setMagnet(value); setRequested(null); setName(""); setSearchTerm(""); setSelected(null); save.reset()
  }
  const files = ready ? preview.data?.files ?? [] : []
  const episodes = files.filter(file => file.kind === "video" && file.episode !== null)
  return <form onSubmit={submit} className="grid gap-4">
    <Field label="磁力链接" hint="单个磁力下载整季合集。解析原始目录后，自动搜索 TMDB。">
      <div className="flex flex-col gap-2 sm:flex-row"><Input value={magnet} onChange={event => resetMagnet(event.target.value)} placeholder="magnet:?xt=urn:btih:…" required disabled={save.isPending}/><Button type="button" variant="secondary" disabled={!magnet.trim() || parsing || save.isPending} onClick={() => { save.reset(); setRequested({ magnet: magnet.trim(), started: Date.now() }) }}><ScanSearch size={15}/>{parsing ? "解析中…" : "解析磁力"}</Button></div>
    </Field>
    {parsing && <p role="status" className="flex items-center gap-2 text-sm text-[var(--muted)]"><LoaderCircle size={16} className="animate-spin"/>正在获取文件清单，最多等待两分钟…</p>}
    {preview.isError && requested && <p role="alert" className="text-sm text-[var(--danger)]">{preview.error.message}</p>}
    {ready && <>
      <Field label="作品名称" hint="选择 TMDB 条目后填入对应作品名称，也可自行修改媒体库名称。">
        <div className="flex flex-col gap-2 sm:flex-row"><Input value={name} onChange={event => setName(event.target.value)} maxLength={160} required disabled={save.isPending}/><Button type="button" variant="secondary" disabled={!name.trim() || candidates.isFetching || save.isPending} onClick={() => { setSelected(null); if (searchTerm === name.trim()) void candidates.refetch(); else setSearchTerm(name.trim()) }}><ScanSearch size={15}/>{candidates.isFetching ? "搜索中…" : "搜索 TMDB"}</Button></div>
      </Field>
      <div role="group" aria-label="匹配 TMDB 条目" className="grid gap-1.5 text-sm">
        <p className="font-medium">匹配 TMDB 条目</p>
        <div className="max-h-64 space-y-2 overflow-y-auto rounded-[2px] border border-[var(--border)] p-2">
          {candidates.isFetching ? <p role="status" className="p-3 text-sm text-[var(--muted)]">正在搜索 TMDB…</p> : candidates.isError ? <p role="alert" className="p-3 text-sm text-[var(--danger)]">{candidates.error.message}</p> : !candidates.data?.length ? <p className="p-3 text-sm text-[var(--muted)]">未找到匹配作品，请调整名称后搜索。</p> : candidates.data.map(candidate => <NativeButton key={candidate.tmdb_id} type="button" disabled={save.isPending} aria-pressed={selected?.tmdb_id === candidate.tmdb_id} onClick={() => { setSelected(candidate); setName(candidate.title) }} className={`flex w-full gap-3 rounded-[2px] border p-2.5 text-left ${selected?.tmdb_id === candidate.tmdb_id ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-transparent hover:border-[var(--border)]"}`}>
            <div className="grid h-20 w-14 shrink-0 place-items-center overflow-hidden bg-[var(--surface)]">{candidate.poster_url ? <img src={candidate.poster_url} alt="" className="h-full w-full object-cover"/> : <ImageOff size={18}/>}</div>
            <div className="min-w-0 flex-1"><p className="font-semibold">{candidate.title}</p><p className="text-xs text-[var(--muted)]">TMDB #{candidate.tmdb_id}{candidate.release_date ? ` · ${candidate.release_date}` : ""}</p>{candidate.overview && <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--muted)]">{candidate.overview}</p>}</div>{selected?.tmdb_id === candidate.tmdb_id && <Check size={17} className="shrink-0 text-[var(--accent)]"/>}
          </NativeButton>)}
        </div>
        <p className="text-[13px] text-[var(--muted)]">选择对应的电视节目，季度在下方单独确认。</p>
      </div>
      {selected && <p role="status" className="text-sm text-[var(--muted)]">{detail.isFetching ? "正在刮削作品信息…" : detail.isError ? `刮削失败：${detail.error.message}` : detail.data ? `已刮削：${detail.data.title}${detail.data.episode_count ? ` · ${detail.data.episode_count} 集` : ""}` : "等待刮削结果"}</p>}
      <Field label="季度" hint="按 TMDB 的季度编号确认；名称末尾的数字仅作为初始建议。一个合集整理到同一季。"><Input type="number" min={0} max={99} step={1} required value={season} onChange={event => setSeason(event.target.value)} disabled={save.isPending}/></Field>
      <Field label={`原始文件清单 · ${files.length} 个文件 · ${((preview.data?.size ?? 0) / 1024 ** 3).toFixed(2)} GiB`} hint="按各文件集数整理正片；匹配外挂字幕随正片改名，片头片尾、菜单和特典跳过。无法识别的正片会提示确认。">
        <div className="max-h-48 overflow-y-auto rounded-[2px] border border-[var(--border)] p-3 font-mono text-xs leading-5">{files.map(file => <div key={file.name} className="mb-1 break-all"><span className="mr-2 text-[var(--muted)]">{file.kind === "extra" ? "跳过" : file.kind === "video" ? file.episode === null ? "待确认" : `E${String(file.episode).padStart(2, "0")}` : "附件"}</span>{file.name}</div>)}</div>
      </Field>
      {episodes.length > 0 && name.trim() && season !== "" && <p className="break-all text-xs leading-5 text-[var(--muted)]">整理示例：{name} \ Season {season.padStart(2, "0")} \ {name} S{season.padStart(2, "0")}E{String(episodes[0].episode).padStart(2, "0")}.mkv</p>}
    </>}
    {save.error && <p role="alert" className="text-sm text-[var(--danger)]">{save.error.message}</p>}
    <DialogFooter><Button type="button" variant="secondary" disabled={save.isPending} onClick={onClose}>取消</Button><Button disabled={!ready || !selected || !detail.data || detail.isError || !name.trim() || season === "" || save.isPending}>{save.isPending ? "添加中…" : "添加合集并下载"}</Button></DialogFooter>
  </form>
}
