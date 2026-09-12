import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Upload } from "lucide-react"
import { api, type Show } from "@/lib/api"
import { ActionButton } from "@/components/ui/action-button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useToast } from "@/components/ui/toast"

type Kind = "poster" | "fanart" | "clearlogo"
const labels: Record<Kind, string> = { poster: "海报 poster", fanart: "背景 fanart", clearlogo: "透明标志 clearlogo" }

function UploadField({ show, kind }: { show: Show; kind: Kind }) {
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const client = useQueryClient()
  const toast = useToast()
  useEffect(() => {
    if (!file) { setPreview(null); return }
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])
  const upload = useMutation({
    mutationFn: (image: File) => api<Show>(`/shows/${show.id}/artwork/${kind}`, {
      method: "POST", body: image, headers: { "Content-Type": image.type || "application/octet-stream" },
    }),
    onSuccess: (updated) => {
      client.setQueryData<Show[]>(["shows"], old => old?.map(item => item.id === updated.id ? updated : item))
      void client.invalidateQueries({ queryKey: ["shows"] })
      toast(`${labels[kind]} 已上传`)
    },
    onError: (error) => toast("图片上传失败", { description: error.message, tone: "error" }),
  })
  const existing = show[`${kind}_ready`] ? `/api/v1/shows/${show.id}/artwork/${kind}?v=${encodeURIComponent(show.artwork_version ?? "")}` : null
  return <section className="grid gap-3 border border-[var(--border)] bg-[var(--paper)] p-4">
    <h3 className="text-sm font-medium">{labels[kind]}</h3>
    <div className="grid h-32 place-items-center overflow-hidden bg-black/5">{preview || existing ? <img src={preview ?? existing!} alt={`${labels[kind]}预览`} className="max-h-32 max-w-full object-contain"/> : <span className="text-xs text-[var(--muted)]">暂无图片</span>}</div>
    <input type="file" aria-label={`选择${labels[kind]}`} accept="image/jpeg,image/png,image/webp" disabled={upload.isPending} className="w-full min-w-0 text-xs" onChange={event => {
      const image = event.target.files?.[0]
      if (!image) return
      if (image.size > 10 * 1024 * 1024) { toast("图片不能超过 10 MB", { tone: "error" }); event.target.value = ""; return }
      setFile(image)
    }}/>
    <ActionButton icon={Upload} pendingLabel="上传中…" pending={upload.isPending} disabled={!file} onClick={() => file && upload.mutate(file)}>上传 {kind}</ActionButton>
  </section>
}

export function ArtworkUpload({ show, onClose }: { show: Show | null; onClose: () => void }) {
  return <Dialog open={Boolean(show)} onOpenChange={open => !open && onClose()}><DialogContent>
    <DialogHeader><DialogTitle>上传番剧图片</DialogTitle><DialogDescription>{show?.name} · 支持 PNG、JPEG、WebP，单张最大 10 MB。上传后替换对应图片；透明标志建议使用透明 PNG。</DialogDescription></DialogHeader>
    {show && <div className="grid gap-4 sm:grid-cols-3">{(["poster", "fanart", "clearlogo"] as Kind[]).map(kind => <UploadField key={`${show.id}-${kind}`} show={show} kind={kind}/>)}</div>}
  </DialogContent></Dialog>
}
