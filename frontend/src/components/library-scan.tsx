import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ScanSearch } from "lucide-react"
import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { useToast } from "@/components/ui/toast"

type ScanStatus = {
  running: boolean
  finished_at: string | null
  interval_seconds: number
  scanned: number
  changed: number
  thumbnails: number
  errors: number
}

export function LibraryScan() {
  const client = useQueryClient()
  const toast = useToast()
  const status = useQuery({
    queryKey: ["library-scan"],
    queryFn: () => api<ScanStatus>("/settings/library-scan"),
    refetchInterval: (query) => (query.state.data?.running ? 5000 : false),
    refetchOnWindowFocus: false,
  })
  const scan = useMutation({
    mutationFn: () => api<{ message: string }>("/settings/library-scan", { method: "POST" }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["library-scan"] })
    },
    onError: (error) => toast("无法开始扫描", { description: error.message, tone: "error" }),
  })
  const data = status.data
  return (
    <div className="border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-medium">本地图片扫描</p>
        <Button
          size="sm"
          variant="secondary"
          icon={ScanSearch}
          pending={scan.isPending || data?.running}
          pendingLabel="扫描中…"
          disabled={!data}
          onClick={() => scan.mutate()}
        >
          立即扫描
        </Button>
      </div>
      <p className="mt-2 text-[13px] leading-6 text-muted">
        {data && data.interval_seconds > 0 ? `每 ${data.interval_seconds} 秒自动扫描` : "仅在点击“立即扫描”后扫描"}
        已订阅作品的海报、背景图、Logo 和单集缩略图，保留已确认的作品匹配。
      </p>
      <div aria-live="polite" className="mt-2 text-xs leading-6 text-muted">
        {status.error ? (
          <p role="alert">扫描状态读取失败：{status.error.message}</p>
        ) : data?.running ? (
          <p>正在扫描，已检查 {data.scanned} 部作品…</p>
        ) : data?.finished_at ? (
          <>
            <p>最近完成：{new Date(data.finished_at).toLocaleString("zh-CN")}</p>
            <p>
              检查 {data.scanned} 部 · 更新 {data.changed} 部 · 发现 {data.thumbnails} 张单集缩略图
              {data.errors > 0 && ` · ${data.errors} 部目录暂时无法扫描`}
            </p>
          </>
        ) : (
          <p>{data && data.interval_seconds > 0 ? "等待首次扫描。" : "自动扫描已关闭，可按需手动扫描。"}</p>
        )}
      </div>
    </div>
  )
}
