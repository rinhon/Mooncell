import { useState, type FormEvent } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { api, type Feed, type TmdbMetadata } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field } from "@/components/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { TagInput } from "@/components/ui/tag-input"
import { useToast } from "@/components/ui/toast"

export function EditSubscriptionDialog({ feed, onClose }: { feed: Feed; onClose: () => void }) {
  const client = useQueryClient()
  const toast = useToast()
  const collection = feed.kind === "magnet"
  const [name, setName] = useState(feed.name)
  const [url, setUrl] = useState(feed.url)
  const [kind, setKind] = useState(feed.kind)
  const [season, setSeason] = useState(feed.season == null ? "" : String(feed.season))
  const [tmdbId, setTmdbId] = useState(feed.show_metadata ? String(feed.show_metadata.tmdb_id) : "")
  const [mediaType, setMediaType] = useState<TmdbMetadata["media_type"]>(feed.show_metadata?.media_type ?? "tv")
  const [excludedKeywords, setExcludedKeywords] = useState(feed.excluded_keywords ?? [])
  const [active, setActive] = useState(feed.active)
  const [interval, setInterval] = useState(String(feed.refresh_interval_minutes))
  const save = useMutation({
    mutationFn: () => api<Feed>(`/feeds/${feed.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: name.trim(), ...(collection ? {} : { url: url.trim(), kind }),
        season: season === "" ? null : Number(season),
        tmdb: tmdbId === "" ? null : { tmdb_id: Number(tmdbId), media_type: mediaType },
        excluded_keywords: excludedKeywords, active, refresh_interval_minutes: Number(interval),
      }),
    }),
    onSuccess: (result) => {
      for (const key of ["feeds", "shows", "dashboard", "downloads", "reviews", "notifications"]) {
        void client.invalidateQueries({ queryKey: [key] })
      }
      if (!result.background_operation_ids?.length) toast(collection ? "合集已修改" : "RSS 订阅已修改")
      onClose()
    },
  })
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!save.isPending) save.mutate()
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !save.isPending) onClose() }}>
    <DialogContent className="max-w-xl">
      <DialogHeader>
        <DialogTitle>{collection ? "编辑磁力合集" : "编辑 RSS 订阅"}</DialogTitle>
        <DialogDescription>{collection ? "修改合集的作品名称、TMDB 关联和季度，已有文件同步整理。" : "修改此订阅的发布源、TMDB 关联和下载筛选条件。"}</DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} className="grid gap-4">
        <Field label="番剧名称" hint="修改后同步已有下载的文件名、番剧目录与 qB 番剧标签，保留原任务名；和季度同时修改时按新番名生成目标路径。">
          <Input value={name} onChange={(event) => setName(event.target.value)} required maxLength={160} disabled={save.isPending}/>
        </Field>
        <Field label={collection ? "磁力链接" : "RSS 地址"}>
          <Input type={collection ? "text" : "url"} pattern={collection ? undefined : "https?://.+"} value={url} onChange={(event) => setUrl(event.target.value)} required disabled={save.isPending || collection}/>
        </Field>
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <Field label="TMDB ID" hint="填写后自动更新元数据和图片；清空解除关联，保留本地图片。">
            <Input type="number" min={1} max={Number.MAX_SAFE_INTEGER} step={1} value={tmdbId} onChange={(event) => setTmdbId(event.target.value)} placeholder="未关联" disabled={save.isPending}/>
          </Field>
          <Field label="TMDB 类型" hint="与该 ID 对应的 TMDB 条目类型一致。">
            <Select value={mediaType} onValueChange={(value) => setMediaType(value as TmdbMetadata["media_type"])} disabled={save.isPending || tmdbId === ""}>
              <SelectTrigger><SelectValue/></SelectTrigger>
              <SelectContent><SelectItem value="tv">电视节目</SelectItem>{!collection && <SelectItem value="movie">电影</SelectItem>}</SelectContent>
            </Select>
          </Field>
        </div>
        {!collection && <Field label="排除关键词" hint="标题包含任意关键词的后续发布会被跳过，不区分大小写；清空则不过滤。已有下载保留。">
          <TagInput value={excludedKeywords} onChange={setExcludedKeywords} label="编辑排除关键词" disabled={save.isPending}/>
        </Field>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="季度" hint="修改后同步已有下载的季度、文件名和保存路径，集数不变。留空按原始发布标题识别；0 表示特别篇。">
            <Input type="number" min={0} max={99} step={1} value={season} onChange={(event) => setSeason(event.target.value)} placeholder="自动识别" disabled={save.isPending}/>
          </Field>
          {!collection && <Field label="刷新间隔（分钟）" hint="仅用于此订阅；修改全局间隔会统一覆盖。">
            <Input type="number" min={1} max={1440} step={1} required value={interval} onChange={(event) => setInterval(event.target.value)} disabled={save.isPending}/>
          </Field>}
        </div>
        {!collection && <Field label="类型">
          <Select value={kind} onValueChange={(value) => setKind(value as Feed["kind"])} disabled={save.isPending}>
            <SelectTrigger><SelectValue/></SelectTrigger>
            <SelectContent><SelectItem value="mikan">Mikan Project</SelectItem><SelectItem value="standard">标准 RSS / Atom</SelectItem></SelectContent>
          </Select>
        </Field>}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} disabled={save.isPending} className="size-4 accent-[var(--accent)]"/>
          {collection ? "启用合集下载与整理" : "启用订阅（自动刷新和下载）"}
        </label>
        {save.error && <p role="alert" className="rounded-[2px] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">{save.error.message}</p>}
        <DialogFooter>
          <Button type="button" variant="secondary" disabled={save.isPending} onClick={onClose}>取消</Button>
          <Button disabled={save.isPending || !name.trim() || !url.trim()}>{save.isPending ? "保存中…" : "保存修改"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}
