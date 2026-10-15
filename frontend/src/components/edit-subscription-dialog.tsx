import { useState, type FormEvent } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { api, type Feed } from "@/lib/api"
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
  const [name, setName] = useState(feed.name)
  const [url, setUrl] = useState(feed.url)
  const [kind, setKind] = useState(feed.kind)
  const [season, setSeason] = useState(feed.season == null ? "" : String(feed.season))
  const [excludedKeywords, setExcludedKeywords] = useState(feed.excluded_keywords ?? [])
  const [active, setActive] = useState(feed.active)
  const [interval, setInterval] = useState(String(feed.refresh_interval_minutes))
  const save = useMutation({
    mutationFn: () => api<Feed>(`/feeds/${feed.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: name.trim(), url: url.trim(), kind,
        season: season === "" ? null : Number(season),
        excluded_keywords: excludedKeywords, active, refresh_interval_minutes: Number(interval),
      }),
    }),
    onSuccess: () => {
      for (const key of ["feeds", "shows", "dashboard", "downloads", "reviews"]) {
        void client.invalidateQueries({ queryKey: [key] })
      }
      toast("RSS 订阅已修改", name.trim() !== feed.name || season !== (feed.season == null ? "" : String(feed.season))
        ? { description: "已有下载将在后台同步番剧标签、文件名和保存路径，保留 qB 任务名与集数。" }
        : undefined)
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
        <DialogTitle>编辑 RSS 订阅</DialogTitle>
        <DialogDescription>修改此订阅的发布源和下载筛选条件。</DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} className="grid gap-4">
        <Field label="番剧名称" hint="修改后同步已有下载的文件名、番剧目录与 qB 番剧标签，保留原任务名；和季度同时修改时按新番名生成目标路径。">
          <Input value={name} onChange={(event) => setName(event.target.value)} required maxLength={160} disabled={save.isPending}/>
        </Field>
        <Field label="RSS 地址">
          <Input type="url" pattern="https?://.+" value={url} onChange={(event) => setUrl(event.target.value)} required disabled={save.isPending}/>
        </Field>
        <Field label="排除关键词" hint="标题包含任意关键词的后续发布会被跳过，不区分大小写；清空则不过滤。已有下载保留。">
          <TagInput value={excludedKeywords} onChange={setExcludedKeywords} label="编辑排除关键词" disabled={save.isPending}/>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="季度" hint="修改后同步已有下载的季度、文件名和保存路径，集数不变。留空按原始发布标题识别；0 表示特别篇。">
            <Input type="number" min={0} max={99} step={1} value={season} onChange={(event) => setSeason(event.target.value)} placeholder="自动识别" disabled={save.isPending}/>
          </Field>
          <Field label="刷新间隔（分钟）" hint="仅用于此订阅；修改全局间隔会统一覆盖。">
            <Input type="number" min={1} max={1440} step={1} required value={interval} onChange={(event) => setInterval(event.target.value)} disabled={save.isPending}/>
          </Field>
        </div>
        <Field label="类型">
          <Select value={kind} onValueChange={(value) => setKind(value as Feed["kind"])} disabled={save.isPending}>
            <SelectTrigger><SelectValue/></SelectTrigger>
            <SelectContent><SelectItem value="mikan">Mikan Project</SelectItem><SelectItem value="standard">标准 RSS / Atom</SelectItem></SelectContent>
          </Select>
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} disabled={save.isPending} className="size-4 accent-[var(--accent)]"/>
          启用订阅（自动刷新和下载）
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
