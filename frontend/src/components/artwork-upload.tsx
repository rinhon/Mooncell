import { useEffect, useRef, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Upload } from "lucide-react"
import { api, type Show } from "@/lib/api"
import { ActionButton } from "@/components/ui/action-button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useToast } from "@/components/ui/toast"

import { artworkUrl } from "@/lib/show-artwork"
import "./artwork-upload.css"

type Kind = "poster" | "fanart" | "clearlogo"
const labels: Record<Kind, string> = { poster: "海报 poster", fanart: "背景 fanart", clearlogo: "透明标志 clearlogo" }

function UploadField({ show, kind }: { show: Show; kind: Kind }) {
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const client = useQueryClient()
  const toast = useToast()
  useEffect(() => {
    if (!file) {
      setPreview(null)
      return
    }
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])
  const upload = useMutation({
    mutationFn: (image: File) =>
      api<Show>(`/shows/${show.id}/artwork/${kind}`, {
        method: "POST",
        body: image,
        headers: { "Content-Type": image.type || "application/octet-stream" },
      }),
    onSuccess: (updated) => {
      client.setQueryData<Show[]>(["shows"], (old) => old?.map((item) => (item.id === updated.id ? updated : item)))
      void client.invalidateQueries({ queryKey: ["shows"] })
      void client.invalidateQueries({ queryKey: ["feeds"] })
      setFile(null)
      toast(`${labels[kind]} 已上传`)
    },
    onError: (error) => toast("图片上传失败", { description: error.message, tone: "error" }),
  })
  const existing = show[`${kind}_ready`] ? artworkUrl(show, kind) : null
  return (
    <section className="grid gap-3 border border-border bg-paper p-4">
      <h3 className="text-sm font-medium">{labels[kind]}</h3>
      <button
        type="button"
        className="artwork-upload-preview"
        disabled={upload.isPending}
        aria-label={`选择${labels[kind]}图片`}
        onClick={() => fileInput.current?.click()}
      >
        {preview || existing ? (
          <>
            <img src={preview ?? existing!} alt={`${labels[kind]}预览`} />
            <span className="artwork-upload-overlay" aria-hidden="true">
              <Upload size={22} />
              <span>点击选择图片</span>
            </span>
          </>
        ) : (
          <span className="artwork-upload-placeholder" aria-hidden="true">
            <Upload size={24} />
            <span>点击选择图片</span>
          </span>
        )}
      </button>
      {file && (
        <p className="text-xs text-muted break-all" role="status">
          已选择：{file.name}
        </p>
      )}
      <input
        ref={fileInput}
        type="file"
        aria-label={`选择${labels[kind]}`}
        accept="image/jpeg,image/png,image/webp"
        disabled={upload.isPending}
        className="artwork-upload-input w-full min-w-0 text-xs"
        onChange={(event) => {
          const image = event.target.files?.[0]
          // 清空原生选择值，允许再次选择同一个文件进行覆盖上传。
          event.target.value = ""
          if (!image) return
          if (image.size > 10 * 1024 * 1024) {
            toast("图片不能超过 10 MB", { tone: "error" })
            return
          }
          setFile(image)
        }}
      />
      <ActionButton
        icon={Upload}
        pendingLabel="上传中…"
        pending={upload.isPending}
        disabled={!file}
        onClick={() => file && upload.mutate(file)}
      >
        {existing ? "覆盖上传" : "上传"} {kind}
      </ActionButton>
    </section>
  )
}

export function ArtworkUpload({ show, onClose }: { show: Show | null; onClose: () => void }) {
  return (
    <Dialog open={Boolean(show)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>上传番剧图片</DialogTitle>
          <DialogDescription>
            {show?.name} · 支持 PNG、JPEG、WebP，单张最大 10 MB。上传将覆盖对应的已有图片；透明标志建议使用透明 PNG。
          </DialogDescription>
        </DialogHeader>
        {show && (
          <div className="grid gap-4 sm:grid-cols-3">
            {(["poster", "fanart", "clearlogo"] as Kind[]).map((kind) => (
              <UploadField key={`${show.id}-${kind}`} show={show} kind={kind} />
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
