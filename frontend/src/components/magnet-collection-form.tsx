import { useEffect, useId, useState, type FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, ImageOff, LoaderCircle, ScanSearch } from "lucide-react"
import { api, type Feed, type TmdbCandidate, type TmdbMetadata } from "@/lib/api"
import { Field } from "@/components/field"
import { Button, NativeButton } from "@/components/ui/button"
import { DialogFooter } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { useToast } from "@/components/ui/toast"

type CollectionFile = { name: string; size: number; episode: number | null; kind: "video" | "extra" | "attachment" }
type FileOverride = { path: string; episode: number }
type Preview = {
  status: "pending" | "ready"
  info_hash: string
  raw_title?: string
  name?: string
  season?: number
  size?: number
  files?: CollectionFile[]
}

function basename(path: string) {
  return path.split(/[\\/]/).pop() ?? path
}

export function MagnetCollectionForm({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const client = useQueryClient()
  const toast = useToast()
  const fileListId = useId()
  const [magnet, setMagnet] = useState("")
  const [requested, setRequested] = useState<{ magnet: string; started: number } | null>(null)
  const [name, setName] = useState("")
  const [season, setSeason] = useState("1")
  const [searchTerm, setSearchTerm] = useState("")
  const [selected, setSelected] = useState<TmdbCandidate | null>(null)
  const [episodeEdits, setEpisodeEdits] = useState<Record<string, string>>({})
  const preview = useQuery({
    queryKey: ["collection-preview", requested],
    enabled: !!requested,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: ({ signal }) => {
      if (Date.now() - requested!.started > 120_000) throw new Error("暂时未找到可用的元数据节点，请稍后重新解析。")
      return api<Preview>("/collections/inspect", {
        method: "POST",
        signal,
        body: JSON.stringify({ magnet: requested!.magnet }),
      })
    },
    refetchInterval: (query) => (query.state.status === "error" || query.state.data?.status === "ready" ? false : 2000),
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
    queryKey: ["collection-tmdb-search", searchTerm],
    enabled: ready && !!searchTerm,
    queryFn: ({ signal }) =>
      api<TmdbCandidate[]>("/tmdb/search", { method: "POST", signal, body: JSON.stringify({ query: searchTerm }) }),
    select: (results) => results.filter((candidate) => candidate.media_type === "tv"),
  })
  const detail = useQuery({
    queryKey: ["collection-tmdb-detail", selected?.tmdb_id],
    enabled: !!selected,
    queryFn: ({ signal }) => api<TmdbMetadata>(`/tmdb/tv/${selected!.tmdb_id}`, { signal }),
  })
  const files = ready ? (preview.data?.files ?? []) : []
  const rows = files.map((file) => {
    const episode = episodeEdits[file.name] ?? (file.episode == null ? "" : String(file.episode))
    const editable = file.kind === "video"
    const episodeError = !editable
      ? null
      : !episode.trim()
        ? "请确认集数"
        : !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(episode.trim()) || !Number.isFinite(Number(episode))
          ? "集数须为非负数字"
          : null
    return {
      file,
      episode,
      filename: basename(file.name),
      editable,
      episodeError,
    }
  })
  const fileOverrides: FileOverride[] = rows.flatMap((row) => {
    if (!row.editable || row.episodeError || Number(row.episode) === row.file.episode) return []
    return [{ path: row.file.name, episode: Number(row.episode) }]
  })
  const hasEpisodeErrors = rows.some((row) => row.episodeError)
  const example = rows.find((row) => row.editable && !row.episodeError)
  const save = useMutation({
    mutationFn: () =>
      api<Feed>("/collections", {
        method: "POST",
        body: JSON.stringify({
          magnet: requested!.magnet,
          name: name.trim(),
          season: Number(season),
          tmdb: { tmdb_id: selected!.tmdb_id, media_type: "tv" },
          file_overrides: fileOverrides,
        }),
      }),
    onSuccess: () => {
      for (const key of ["feeds", "shows", "downloads", "dashboard", "notifications"])
        void client.invalidateQueries({ queryKey: [key] })
      toast("合集已添加", { description: "后台将刮削作品信息，并下载整理正片和匹配字幕。" })
      onClose()
      onAdded()
    },
  })
  function submit(event: FormEvent) {
    event.preventDefault()
    if (
      ready &&
      selected &&
      detail.data &&
      !detail.isError &&
      name.trim() &&
      season !== "" &&
      !hasEpisodeErrors &&
      !save.isPending
    )
      save.mutate()
  }
  function resetMagnet(value: string) {
    setMagnet(value)
    setRequested(null)
    setName("")
    setSearchTerm("")
    setSelected(null)
    setEpisodeEdits({})
    save.reset()
  }
  function editEpisode(path: string, value: string) {
    setEpisodeEdits((current) => ({ ...current, [path]: value }))
    save.reset()
  }
  return (
    <form onSubmit={submit} className="grid gap-4">
      <Field label="磁力链接" hint="单个磁力下载整季合集。解析原始目录后，自动搜索 TMDB。">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={magnet}
            onChange={(event) => resetMagnet(event.target.value)}
            placeholder="magnet:?xt=urn:btih:…"
            required
            disabled={save.isPending}
          />
          <Button
            type="button"
            variant="secondary"
            disabled={!magnet.trim() || parsing || save.isPending}
            onClick={() => {
              save.reset()
              setEpisodeEdits({})
              setRequested({ magnet: magnet.trim(), started: Date.now() })
            }}
          >
            <ScanSearch size={15} />
            {parsing ? "解析中…" : "解析磁力"}
          </Button>
        </div>
      </Field>
      {parsing && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted">
          <LoaderCircle size={16} className="animate-spin" />
          正在获取文件清单，最多等待两分钟…
        </p>
      )}
      {preview.isError && requested && (
        <p role="alert" className="text-sm text-danger">
          {preview.error.message}
        </p>
      )}
      {ready && (
        <>
          <Field label="作品名称" hint="选择 TMDB 条目后填入对应作品名称，也可自行修改媒体库名称。">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={160}
                required
                disabled={save.isPending}
              />
              <Button
                type="button"
                variant="secondary"
                disabled={!name.trim() || candidates.isFetching || save.isPending}
                onClick={() => {
                  setSelected(null)
                  if (searchTerm === name.trim()) void candidates.refetch()
                  else setSearchTerm(name.trim())
                }}
              >
                <ScanSearch size={15} />
                {candidates.isFetching ? "搜索中…" : "搜索 TMDB"}
              </Button>
            </div>
          </Field>
          <div role="group" aria-label="匹配 TMDB 条目" className="grid gap-1.5 text-sm">
            <p className="font-medium">匹配 TMDB 条目</p>
            <div className="max-h-64 space-y-2 overflow-y-auto rounded-card border border-border p-2">
              {candidates.isFetching ? (
                <p role="status" className="p-3 text-sm text-muted">
                  正在搜索 TMDB…
                </p>
              ) : candidates.isError ? (
                <p role="alert" className="p-3 text-sm text-danger">
                  {candidates.error.message}
                </p>
              ) : !candidates.data?.length ? (
                <p className="p-3 text-sm text-muted">未找到匹配作品，请调整名称后搜索。</p>
              ) : (
                candidates.data.map((candidate) => (
                  <NativeButton
                    key={candidate.tmdb_id}
                    type="button"
                    disabled={save.isPending}
                    aria-label={`${candidate.title}，电视节目，TMDB #${candidate.tmdb_id}`}
                    aria-pressed={selected?.tmdb_id === candidate.tmdb_id}
                    onClick={() => {
                      setSelected(candidate)
                      setName(candidate.title)
                    }}
                    className={[
                      "flex w-full gap-3 rounded-control border p-2.5 text-left",
                      selected?.tmdb_id === candidate.tmdb_id
                        ? "border-accent bg-accent-soft"
                        : "border-transparent hover:border-border",
                    ].join(" ")}
                  >
                    <div className="grid h-20 w-14 shrink-0 place-items-center overflow-hidden rounded-inset bg-surface">
                      {candidate.poster_url ? (
                        <img src={candidate.poster_url} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <ImageOff size={18} />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold">{candidate.title}</p>
                      <p className="text-xs text-muted">
                        TMDB #{candidate.tmdb_id}
                        {candidate.release_date ? ` · ${candidate.release_date}` : ""}
                      </p>
                      {candidate.overview && (
                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted">{candidate.overview}</p>
                      )}
                    </div>
                    {selected?.tmdb_id === candidate.tmdb_id && <Check size={17} className="shrink-0 text-accent" />}
                  </NativeButton>
                ))
              )}
            </div>
            <p className="text-[13px] text-muted">选择对应的电视节目，季度在下方单独确认。</p>
          </div>
          {selected && (
            <p role="status" className="text-sm text-muted">
              {detail.isFetching
                ? "正在刮削作品信息…"
                : detail.isError
                  ? `刮削失败：${detail.error.message}`
                  : detail.data
                    ? `已刮削：${detail.data.title}${detail.data.episode_count ? ` · ${detail.data.episode_count} 集` : ""}`
                    : "等待刮削结果"}
            </p>
          )}
          <Field label="季度" hint="按 TMDB 的季度编号确认；名称末尾的数字仅作为初始建议。一个合集整理到同一季。">
            <Input
              type="number"
              min={0}
              max={99}
              step={1}
              required
              value={season}
              onChange={(event) => setSeason(event.target.value)}
              disabled={save.isPending}
            />
          </Field>
          <div className="grid gap-1.5 text-sm">
            <p className="font-medium">
              原始文件清单 · {files.length} 个文件 · {((preview.data?.size ?? 0) / 1024 ** 3).toFixed(2)} GiB
            </p>
            <div className="max-h-48 overflow-y-auto rounded-control border border-border">
              <table aria-label="原始文件清单" className="w-full table-fixed text-left text-xs leading-5">
                <colgroup>
                  <col className="w-24" />
                  <col />
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col" className="sticky top-0 bg-surface px-3 py-2 font-medium text-muted">
                      集数
                    </th>
                    <th scope="col" className="sticky top-0 bg-surface px-3 py-2 font-medium text-muted">
                      文件名
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((row, index) => (
                    <tr key={row.file.name}>
                      <td className="px-3 py-2 align-top text-muted">
                        {row.editable ? (
                          <>
                            <Input
                              type="text"
                              inputMode="decimal"
                              required
                              placeholder="待确认"
                              aria-label={`第 ${index + 1} 个文件的集数`}
                              aria-invalid={Boolean(row.episodeError)}
                              aria-describedby={row.episodeError ? `${fileListId}-episode-${index}` : undefined}
                              className="h-8 min-w-0 px-2 font-mono text-xs"
                              value={row.episode}
                              disabled={save.isPending}
                              onChange={(event) => editEpisode(row.file.name, event.target.value)}
                            />
                            {row.episodeError && (
                              <p id={`${fileListId}-episode-${index}`} className="mt-1 text-xs text-danger">
                                {row.episodeError}
                              </p>
                            )}
                          </>
                        ) : (
                          <span className="font-mono">{row.file.kind === "extra" ? "跳过" : "附件"}</span>
                        )}
                      </td>
                      <td className="break-all px-3 py-2 align-top font-mono">{row.filename}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[13px] text-muted">
              原文件名仅供核对。修改集数后，按作品名称、季度和集数生成整理名称；匹配字幕随正片改名，片头片尾、菜单和特典跳过。
            </p>
          </div>
          {example && name.trim() && season !== "" && (
            <p className="break-all text-xs leading-5 text-muted">
              整理示例：{name} \ Season {season.padStart(2, "0")} \{" "}
              {`${name} S${season.padStart(2, "0")}E${String(Number(example.episode)).padStart(2, "0")}${example.filename.slice(example.filename.lastIndexOf("."))}`}
            </p>
          )}
        </>
      )}
      {save.error && (
        <p role="alert" className="text-sm text-danger">
          {save.error.message}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="secondary" disabled={save.isPending} onClick={onClose}>
          取消
        </Button>
        <Button
          disabled={
            !ready ||
            !selected ||
            !detail.data ||
            detail.isError ||
            !name.trim() ||
            season === "" ||
            hasEpisodeErrors ||
            save.isPending
          }
        >
          {save.isPending ? "添加中…" : "添加合集并下载"}
        </Button>
      </DialogFooter>
    </form>
  )
}
