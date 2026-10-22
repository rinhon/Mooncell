import { useState, type FormEvent } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { api, type ShowEpisode } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field } from "@/components/field"
import { Input } from "@/components/ui/input"
import { useToast } from "@/components/ui/toast"

export function RenameEpisodeDialog({ sourceId, episode, onClose }: { sourceId: number; episode: ShowEpisode; onClose: () => void }) {
  const [filename, setFilename] = useState(episode.filename)
  const client = useQueryClient()
  const toast = useToast()
  const rename = useMutation({
    mutationFn: () => api<{ message: string; pending: boolean }>(`/shows/${sourceId}/episodes/rename`, {
      method: "POST",
      body: JSON.stringify({ media_id: episode.media_id, filename }),
    }),
    onSuccess: result => {
      for (const key of ["shows", "downloads", "logs"]) void client.invalidateQueries({ queryKey: [key] })
      toast(result.message)
      onClose()
    },
  })
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!rename.isPending) rename.mutate()
  }
  return <Dialog open onOpenChange={open => { if (!open && !rename.isPending) onClose() }}>
    <DialogContent className="max-w-xl">
      <DialogHeader>
        <DialogTitle>单集改名</DialogTitle>
        <DialogDescription>通过 qBittorrent 修改此视频文件名，保留做种。目录和扩展名保持不变，外挂字幕需单独改名。</DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} className="grid gap-4">
        <p className="break-all text-xs text-[var(--muted)]">当前文件：{episode.path}</p>
        <Field label="新文件名" hint="包含原扩展名；同一文件夹中不能重名。">
          <Input autoFocus value={filename} required maxLength={255} disabled={rename.isPending}
            onChange={event => { setFilename(event.target.value); rename.reset() }}
            onFocus={event => event.currentTarget.setSelectionRange(0, Math.max(0, filename.lastIndexOf(".")))}/>
        </Field>
        {rename.error && <p role="alert" className="rounded-[var(--radius-control)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">{rename.error.message}</p>}
        <DialogFooter>
          <Button type="button" variant="secondary" disabled={rename.isPending} onClick={onClose}>取消</Button>
          <Button disabled={rename.isPending || !filename.trim() || filename === episode.filename}>{rename.isPending ? "改名中…" : "保存文件名"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}
