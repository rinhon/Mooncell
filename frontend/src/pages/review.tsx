import { useEffect, useState, type ComponentProps } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useSearchParams } from "react-router-dom"
import { Check, FileSearch, RotateCcw, Trash2, TriangleAlert } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ActionButton } from "@/components/ui/action-button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field } from "@/components/field"
import { Input } from "@/components/ui/input"
import { useToast } from "@/components/ui/toast"
import { api, type ParsedRelease } from "@/lib/api"

type Review = {
  id: number
  raw_title: string
  source_name: string
  source_active: boolean
  parsed: ParsedRelease
  season: number | null
  reason: string
  proposed_path: string | null
  job_state: string | null
}
type ReviewFile = { name: string; episode: number | null }
type Correction = { name: string; episode: string; skip: boolean }
const validNumber = (value: string, max: number) =>
  value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= max

export function ReviewDialog({
  open,
  onOpenChange,
  onCloseAutoFocus,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCloseAutoFocus?: ComponentProps<typeof DialogContent>["onCloseAutoFocus"]
}) {
  const toast = useToast()
  const client = useQueryClient()
  const reviews = useQuery({
    queryKey: ["reviews"],
    queryFn: () => api<Review[]>("/review"),
    enabled: open,
    refetchInterval: open ? 10000 : false,
  })
  const [searchParams] = useSearchParams()
  const querySearch = searchParams.get("q") ?? ""
  const [search, setSearch] = useState(querySearch)
  const [editing, setEditing] = useState<Review | null>(null)
  const [ignoring, setIgnoring] = useState<Review | null>(null)
  const [title, setTitle] = useState("")
  const [season, setSeason] = useState("1")
  const [episode, setEpisode] = useState("")
  const [corrections, setCorrections] = useState<Correction[]>([])
  const [formError, setFormError] = useState("")
  useEffect(() => {
    if (open) setSearch(querySearch)
    else {
      setEditing(null)
      setIgnoring(null)
      setCorrections([])
      setFormError("")
    }
  }, [open, querySearch])
  const files = useQuery({
    queryKey: ["review-files", editing?.id],
    queryFn: () => api<ReviewFile[]>(`/review/${editing!.id}/files`),
    enabled: open && Boolean(editing?.job_state),
    retry: false,
    refetchOnWindowFocus: false,
  })
  useEffect(() => {
    setCorrections(
      (files.data ?? []).map((file) => ({
        name: file.name,
        episode: file.episode == null ? "" : String(file.episode),
        skip: false,
      })),
    )
  }, [files.data, editing?.id])
  const action = useMutation({
    mutationFn: ({ id, kind, body }: { id: number; kind: "approve" | "ignore" | "reparse"; body?: object }) =>
      api<{ message: string }>(`/review/${id}/${kind}`, {
        method: "POST",
        body: body ? JSON.stringify(body) : undefined,
      }),
    onSuccess: (result, variables) => {
      toast(result.message)
      if (variables.kind === "approve") setEditing(null)
      if (variables.kind === "ignore") setIgnoring(null)
      setFormError("")
      for (const key of ["reviews", "review-files", "dashboard", "downloads", "logs", "notifications"])
        void client.invalidateQueries({ queryKey: [key] })
    },
    onError: (error) => {
      setFormError(error.message)
      toast("审核操作失败", { description: error.message, tone: "error" })
    },
  })
  function edit(item: Review) {
    setEditing(item)
    setTitle(
      item.parsed.evidence.includes("manual_review") ? (item.parsed.title ?? item.source_name) : item.source_name,
    )
    setSeason(String(item.season ?? 1))
    setEpisode(item.parsed.episode_start == null ? "" : String(item.parsed.episode_start))
    setCorrections([])
    setFormError("")
  }
  const valid =
    title.trim() !== "" &&
    validNumber(season, 99) &&
    Number.isInteger(Number(season)) &&
    validNumber(episode, 99999) &&
    (!editing?.job_state ||
      (!files.isPending &&
        !files.isError &&
        corrections.length > 0 &&
        corrections.some((file) => !file.skip) &&
        corrections.every((file) => file.skip || validNumber(file.episode, 99999))))
  const items = (reviews.data ?? []).filter((item) =>
    `${item.source_name} ${item.raw_title} ${item.reason}`.toLowerCase().includes(search.toLowerCase()),
  )
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next || !action.isPending) onOpenChange(next)
      }}
    >
      <DialogContent className="max-w-6xl" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>审核收件箱</DialogTitle>
          <DialogDescription>确认发布信息与文件集数后继续下载；路径冲突仍会检查，避免覆盖已有剧集。</DialogDescription>
        </DialogHeader>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <Input
            className="min-w-0 max-w-xl flex-1 basis-64"
            aria-label="搜索审核条目"
            placeholder="搜索番名、原标题或审核原因"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="flex items-center gap-2">
            <Badge tone={reviews.data?.length ? "warning" : "success"}>{reviews.data?.length ?? 0} 项待处理</Badge>
            <ActionButton
              icon={RotateCcw}
              pending={reviews.isFetching}
              pendingLabel="刷新中…"
              emphasis="secondary"
              onClick={() => void reviews.refetch()}
            >
              刷新
            </ActionButton>
          </div>
        </div>
        {reviews.isPending && <p className="text-sm text-muted">正在加载审核条目…</p>}
        {reviews.isError && (
          <Card>
            <CardContent className="pt-6">
              <p role="alert" className="text-warning">
                审核列表加载失败：{reviews.error.message}
              </p>
              <Button className="mt-3" onClick={() => void reviews.refetch()}>
                重试
              </Button>
            </CardContent>
          </Card>
        )}
        {!reviews.isPending && !reviews.isError && items.length === 0 && (
          <Card>
            <CardContent className="py-10 text-center">
              <Check className="mx-auto mb-3 text-accent" />
              <p>{reviews.data?.length ? "没有符合搜索条件的条目" : "当前没有待审核条目"}</p>
              <p className="mt-2 text-sm text-muted">低置信度发布与下载整理异常会自动出现在这里。</p>
            </CardContent>
          </Card>
        )}
        <div className="grid gap-4">
          {items.map((item) => (
            <Card key={item.id}>
              <CardHeader>
                <div className="flex items-start gap-3">
                  <TriangleAlert size={18} className="mt-1 shrink-0 text-warning" />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <CardTitle>{item.source_name}</CardTitle>
                      <Badge tone="warning">{item.job_state ? "整理待审核" : "发布待审核"}</Badge>
                      <Badge>置信度 {Math.round(item.parsed.confidence * 100)}%</Badge>
                      {!item.source_active && <Badge>订阅已停用</Badge>}
                    </div>
                    <CardDescription className="mt-2 break-all">{item.raw_title}</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="rounded-control bg-surface/20 p-4 ring-1 ring-border">
                    <p className="text-xs font-semibold text-muted">解析证据</p>
                    <p className="mt-3 text-sm">
                      季度 {item.season ?? "未识别"} · 集数 {item.parsed.episode_start ?? "未识别"} ·{" "}
                      {item.parsed.release_kind === "single" ? "单集" : "合集 / 范围发布"}
                    </p>
                    <div className="mt-3 grid gap-2">
                      {item.parsed.evidence.map((value, index) => (
                        <p key={index} className="flex gap-2 text-sm text-muted">
                          <Check size={15} className="mt-0.5 shrink-0 text-accent" />
                          {value}
                        </p>
                      ))}
                    </div>
                    <p className="mt-3 break-all text-sm text-warning">{item.reason}</p>
                  </div>
                  <div className="rounded-control bg-surface/20 p-4 ring-1 ring-border">
                    <p className="text-xs font-semibold text-muted">拟执行路径（单集示例）</p>
                    <p className="mt-3 break-all font-mono text-xs leading-6">
                      {item.proposed_path ?? "缺少季度或集数，请先修正"}
                    </p>
                    <p className="mt-3 text-[13px] text-muted">
                      实际文件扩展名保持原样；合集在获取元数据后逐文件确认。
                    </p>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap justify-end gap-2">
                  <ActionButton
                    icon={Trash2}
                    disabled={action.isPending}
                    pendingLabel="忽略中…"
                    emphasis="secondary"
                    onClick={() => {
                      setIgnoring(item)
                      setFormError("")
                    }}
                  >
                    忽略
                  </ActionButton>
                  <ActionButton
                    icon={RotateCcw}
                    pending={
                      action.isPending && action.variables?.id === item.id && action.variables.kind === "reparse"
                    }
                    disabled={action.isPending}
                    pendingLabel="解析中…"
                    emphasis="secondary"
                    onClick={() => action.mutate({ id: item.id, kind: "reparse" })}
                  >
                    重新解析
                  </ActionButton>
                  <ActionButton
                    icon={FileSearch}
                    disabled={action.isPending}
                    pendingLabel="处理中…"
                    onClick={() => edit(item)}
                  >
                    修正并批准
                  </ActionButton>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
        <Dialog
          open={open && Boolean(editing)}
          onOpenChange={(open) => {
            if (!open && !action.isPending) setEditing(null)
          }}
        >
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>修正并批准</DialogTitle>
              <DialogDescription>{editing?.raw_title}</DialogDescription>
            </DialogHeader>
            <form
              onSubmit={(event) => {
                event.preventDefault()
                if (editing && valid && !action.isPending)
                  action.mutate({
                    id: editing.id,
                    kind: "approve",
                    body: {
                      title: title.trim(),
                      season: Number(season),
                      episode: Number(episode),
                      ...(editing.job_state
                        ? {
                            files: corrections.map((file) => ({
                              name: file.name,
                              episode: file.skip ? null : Number(file.episode),
                            })),
                          }
                        : {}),
                    },
                  })
              }}
            >
              <Field label="媒体库番名">
                <Input
                  required
                  value={title}
                  maxLength={160}
                  disabled={action.isPending}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </Field>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <Field label="季度（特别篇可填 0）">
                  <Input
                    aria-label="季度"
                    required
                    type="number"
                    min="0"
                    max="99"
                    step="1"
                    disabled={action.isPending}
                    value={season}
                    onChange={(event) => setSeason(event.target.value)}
                  />
                </Field>
                <Field label="集数 / 合集起始集数">
                  <Input
                    aria-label="集数"
                    required
                    type="number"
                    min="0"
                    max="99999"
                    step="any"
                    disabled={action.isPending}
                    value={episode}
                    onChange={(event) => setEpisode(event.target.value)}
                  />
                </Field>
              </div>
              <p className="mt-3 break-all rounded-inset bg-surface/20 p-3 font-mono text-xs">
                {title || "番名"} / Season {season.padStart(2, "0")} / {title || "番名"} S{season.padStart(2, "0")}E
                {validNumber(episode, 99999) ? String(Number(episode)).padStart(2, "0") : "?"}.
                {editing?.parsed.container ?? "mkv"}
              </p>
              {editing?.job_state && (
                <div className="mt-4 space-y-3">
                  <p className="text-sm font-semibold">逐文件确认</p>
                  <p className="text-[13px] text-muted">
                    填写每个视频的最终集数；勾选跳过的文件将设为不下载。冲突可通过修正番名、季度或集数解决。
                  </p>
                  {files.isPending && <p className="text-sm">正在读取下载器文件…</p>}
                  {files.isError && (
                    <div role="alert" className="text-sm text-warning">
                      {files.error.message}
                      <Button type="button" variant="secondary" className="ml-2" onClick={() => void files.refetch()}>
                        重试
                      </Button>
                    </div>
                  )}
                  {corrections.map((file, index) => (
                    <div key={file.name} className="rounded-control border border-border bg-surface/40 p-3">
                      <p className="mb-2 break-all text-xs">{file.name}</p>
                      <div className="flex items-center gap-3">
                        <Input
                          className="max-w-36"
                          aria-label={`${file.name} 的集数`}
                          type="number"
                          min="0"
                          max="99999"
                          step="any"
                          placeholder="集数"
                          value={file.episode}
                          disabled={file.skip || action.isPending}
                          onChange={(event) =>
                            setCorrections((current) =>
                              current.map((value, i) =>
                                i === index ? { ...value, episode: event.target.value } : value,
                              ),
                            )
                          }
                        />
                        <label className="inline-flex cursor-pointer select-none items-center gap-2 text-sm text-ink-2 hover:text-ink">
                          <input
                            type="checkbox"
                            className="size-4 cursor-pointer rounded-xs border border-border accent-[var(--accent)]"
                            checked={file.skip}
                            disabled={action.isPending}
                            onChange={(event) =>
                              setCorrections((current) =>
                                current.map((value, i) =>
                                  i === index ? { ...value, skip: event.target.checked } : value,
                                ),
                              )
                            }
                          />
                          跳过此文件
                        </label>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {!editing?.job_state && (
                <p className="mt-3 text-[13px] text-muted">
                  批准后进入下载队列。合集如缺少逐文件集数，将在获取元数据后再次进入整理审核。
                </p>
              )}
              {formError && (
                <p role="alert" className="mt-3 text-sm text-warning">
                  {formError}
                </p>
              )}
              <DialogFooter>
                <Button type="button" variant="secondary" disabled={action.isPending} onClick={() => setEditing(null)}>
                  取消
                </Button>
                <Button type="submit" disabled={!valid || action.isPending}>
                  {action.isPending ? "批准中…" : "批准并继续"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
        <Dialog
          open={open && Boolean(ignoring)}
          onOpenChange={(open) => {
            if (!open && !action.isPending) setIgnoring(null)
          }}
        >
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>忽略此条目</DialogTitle>
              <DialogDescription>{ignoring?.raw_title}</DialogDescription>
            </DialogHeader>
            <p className="text-sm text-muted">忽略后不会再自动投递或整理此条目。已有下载任务会暂停，文件会保留。</p>
            {formError && (
              <p role="alert" className="mt-3 text-sm text-warning">
                {formError}
              </p>
            )}
            <DialogFooter>
              <Button variant="secondary" disabled={action.isPending} onClick={() => setIgnoring(null)}>
                取消
              </Button>
              <Button
                disabled={action.isPending}
                onClick={() => ignoring && action.mutate({ id: ignoring.id, kind: "ignore" })}
              >
                {action.isPending ? "忽略中…" : "确认忽略"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  )
}
