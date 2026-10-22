import { useRef, useState, type FormEvent } from "react"
import { useNavigate } from "react-router-dom"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Check, LoaderCircle, ScanSearch } from "lucide-react"
import { api, ApiError, type Feed, type FeedInspection, type TmdbCandidate, type TmdbMetadata } from "@/lib/api"
import { MIKAN_BASE_URL } from "@/lib/mikan"
import { Field } from "@/components/field"
import { TagInput } from "@/components/ui/tag-input"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { DialogFooter } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useToast } from "@/components/ui/toast"
import { TmdbCandidateList } from "./tmdb-candidate-list"

export const CREATE_FEED_MUTATION_KEY = ["create-feed"] as const

export function RssSubscriptionForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const client = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const [season, setSeason] = useState("")
  const [excludedKeywords, setExcludedKeywords] = useState<string[]>(["720"])
  const [kind, setKind] = useState<"mikan" | "standard">("mikan")
  const [candidates, setCandidates] = useState<TmdbCandidate[]>([])
  const [selected, setSelected] = useState<TmdbCandidate | null>(null)
  const [metadata, setMetadata] = useState<TmdbMetadata | null>(null)
  const inspectVersion = useRef(0)
  const searchVersion = useRef(0)
  const detailVersion = useRef(0)
  const metadataMatchesSelected = Boolean(
    metadata && selected && metadata.tmdb_id === selected.tmdb_id && metadata.media_type === selected.media_type,
  )
  function redirectToSettings(error: Error) {
    if (!(error instanceof ApiError) || !["/settings#tmdb", "/settings#downloader"].includes(error.settingsPath ?? ""))
      return false
    toast("添加订阅前请完善设置", { description: error.message, tone: "warning" })
    onClose()
    navigate(error.settingsPath!)
    return true
  }
  const create = useMutation({
    mutationKey: CREATE_FEED_MUTATION_KEY,
    mutationFn: () =>
      api<Feed>("/feeds", {
        method: "POST",
        body: JSON.stringify({
          name,
          url,
          kind,
          excluded_keywords: excludedKeywords,
          season: season === "" ? null : Number(season),
          active: true,
          refresh_interval_minutes: 5,
          tmdb: selected ? { tmdb_id: selected.tmdb_id, media_type: selected.media_type } : null,
        }),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["notifications"] })
      void client.invalidateQueries({ queryKey: ["feeds"] })
      void client.invalidateQueries({ queryKey: ["dashboard"] })
      void client.invalidateQueries({ queryKey: ["shows"] })
      setExcludedKeywords(["720"])
      onSaved()
      setName("")
      setUrl("")
      setSeason("")
      setCandidates([])
      setSelected(null)
      setMetadata(null)
    },
    onError: (error) => {
      redirectToSettings(error)
    },
  })
  const tmdbSearch = useMutation({
    mutationFn: ({ query }: { query: string; version: number }) =>
      api<TmdbCandidate[]>("/tmdb/search", { method: "POST", body: JSON.stringify({ query }) }),
    onSuccess: (results, input) => {
      if (input.version !== searchVersion.current) return
      setCandidates(results)
      setSelected(null)
      setMetadata(null)
      if (!results.length) toast("未找到 TMDB 条目", { description: "可以调整番剧名称后重新搜索。", tone: "warning" })
    },
    onError: (error, input) => {
      if (input.version === searchVersion.current) toast("TMDB 搜索失败", { description: error.message, tone: "error" })
    },
  })
  const tmdbDetail = useMutation({
    mutationFn: ({ candidate }: { candidate: TmdbCandidate; version: number }) =>
      api<TmdbMetadata>(`/tmdb/${candidate.media_type}/${candidate.tmdb_id}`),
    onSuccess: (result, input) => {
      if (input.version === detailVersion.current) setMetadata(result)
    },
    onError: (error, input) => {
      if (input.version === detailVersion.current) toast("TMDB 刮削失败", { description: error.message, tone: "error" })
    },
  })
  const inspect = useMutation({
    mutationFn: ({ url }: { url: string; version: number }) =>
      api<FeedInspection>("/feeds/inspect", { method: "POST", body: JSON.stringify({ url }) }),
    onSuccess: (result, input) => {
      if (input.version !== inspectVersion.current) return
      setName(result.name)
      setKind(result.kind)
      startSearch(result.name)
      toast("RSS 解析完成", { description: `识别为“${result.name}”，包含 ${result.entries} 个发布条目。` })
    },
    onError: (error, input) => {
      if (input.version === inspectVersion.current) toast("RSS 解析失败", { description: error.message, tone: "error" })
    },
  })
  function resetMatch() {
    searchVersion.current += 1
    detailVersion.current += 1
    setCandidates([])
    setSelected(null)
    setMetadata(null)
    tmdbSearch.reset()
    tmdbDetail.reset()
  }
  function startSearch(query: string) {
    inspectVersion.current += 1
    resetMatch()
    tmdbSearch.mutate({ query, version: searchVersion.current })
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    if (metadataMatchesSelected && !create.isPending && !client.isMutating({ mutationKey: CREATE_FEED_MUTATION_KEY })) {
      create.mutate()
    }
  }
  function chooseCandidate(candidate: TmdbCandidate) {
    setSelected(candidate)
    setMetadata(null)
    tmdbDetail.mutate({ candidate, version: ++detailVersion.current })
  }
  return (
    <form onSubmit={submit} className="grid gap-4">
      <fieldset disabled={create.isPending} className="contents">
        <Field
          label={
            <span className="inline-flex items-center gap-2">
              RSS 地址
              <a
                href={MIKAN_BASE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-normal text-ink underline underline-offset-4"
                aria-label="打开蜜柑计划（新标签页）"
              >
                蜜柑计划 ↗
              </a>
            </span>
          }
          hint="后端会读取频道 <title>，并自动清理 Mikan Project 前缀。"
        >
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              type="url"
              value={url}
              onChange={(event) => {
                setUrl(event.target.value)
                inspectVersion.current += 1
                resetMatch()
                inspect.reset()
              }}
              placeholder={`${MIKAN_BASE_URL}/RSS/...`}
              required
            />
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                resetMatch()
                inspect.mutate({ url, version: ++inspectVersion.current })
              }}
              disabled={!url || inspect.isPending}
            >
              <ScanSearch size={15} className={inspect.isPending ? "animate-pulse" : ""} />
              {inspect.isPending ? "解析中…" : "解析 RSS"}
            </Button>
          </div>
        </Field>
        <Field label="番剧名称" hint="解析完成后会自动搜索 TMDB；修改名称后可再次搜索。">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                inspectVersion.current += 1
                searchVersion.current += 1
              }}
              placeholder="留空时由后端自动解析"
            />
            <Button
              type="button"
              variant="secondary"
              onClick={() => startSearch(name)}
              disabled={!name || tmdbSearch.isPending}
            >
              <ScanSearch size={15} />
              {tmdbSearch.isPending ? "搜索中…" : "搜索 TMDB"}
            </Button>
          </div>
        </Field>
        {(tmdbSearch.isPending || tmdbSearch.isSuccess || candidates.length > 0) && (
          <div role="group" aria-label="匹配 TMDB 条目" className="grid gap-1.5 text-sm font-medium text-ink">
            <p>匹配 TMDB 条目</p>
            <TmdbCandidateList
              candidates={candidates}
              selected={selected}
              pending={tmdbSearch.isPending}
              onSelect={chooseCandidate}
            />
            <p className="text-[13px] font-normal text-muted">
              选择正确的作品，Mooncell 会保存 TMDB ID 并刮削媒体信息。
            </p>
          </div>
        )}
        {selected && (
          <div className="rounded-control border border-accent bg-accent-soft px-3 py-2.5 text-sm text-ink">
            {tmdbDetail.isPending ? (
              <span className="flex items-center gap-2">
                <LoaderCircle className="animate-spin" size={15} />
                正在刮削 TMDB #{selected.tmdb_id}…
              </span>
            ) : metadataMatchesSelected && metadata ? (
              <span className="flex items-center gap-2">
                <Check className="text-accent" size={15} />
                已刮削：{metadata.title}
                {metadata.episode_count ? ` · ${metadata.episode_count} 集` : ""}
                {metadata.rating ? ` · ${metadata.rating} 分` : ""}
              </span>
            ) : (
              "等待刮削结果"
            )}
          </div>
        )}
        <Field
          label="排除关键词"
          hint="标题包含任意关键词的发布将被跳过，不区分大小写。默认排除 720（如 720p）；清空则不过滤。"
        >
          <TagInput
            value={excludedKeywords}
            onChange={setExcludedKeywords}
            label="排除关键词"
            disabled={create.isPending}
          />
        </Field>
        <Field label="季度" hint="留空自动识别；填写后优先使用此季度，0 表示特别篇。">
          <Input
            type="number"
            min={0}
            max={99}
            step={1}
            value={season}
            onChange={(event) => setSeason(event.target.value)}
            placeholder="例如：1"
          />
        </Field>
        <Field label="类型">
          <Select value={kind} onValueChange={(value) => setKind(value as typeof kind)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="mikan">Mikan Project</SelectItem>
              <SelectItem value="standard">标准 RSS / Atom</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {tmdbSearch.error && (
          <p className="rounded-control bg-danger-soft px-3 py-2 text-sm text-danger">{tmdbSearch.error.message}</p>
        )}
        {tmdbDetail.error && (
          <p className="rounded-control bg-danger-soft px-3 py-2 text-sm text-danger">{tmdbDetail.error.message}</p>
        )}
        {create.error && (
          <p className="rounded-control bg-danger-soft px-3 py-2 text-sm text-danger">{create.error.message}</p>
        )}
        <DialogFooter>
          <Button type="button" variant="secondary" disabled={create.isPending} onClick={onClose}>
            取消
          </Button>
          <Button disabled={create.isPending || !metadataMatchesSelected}>
            {create.isPending ? "保存中…" : "保存订阅"}
          </Button>
        </DialogFooter>
      </fieldset>
    </form>
  )
}
