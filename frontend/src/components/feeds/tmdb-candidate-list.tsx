import { Check, ImageOff, LoaderCircle } from "lucide-react"
import { NativeButton } from "@/components/ui/button"
import type { TmdbCandidate } from "@/lib/api"

type Props = {
  candidates: TmdbCandidate[]
  selected: TmdbCandidate | null
  pending: boolean
  onSelect: (candidate: TmdbCandidate) => void
}

export function TmdbCandidateList({ candidates, selected, pending, onSelect }: Props) {
  return (
    <div className="max-h-80 space-y-2 overflow-y-auto rounded-card border border-border bg-surface p-2">
      {pending ? (
        <div className="flex min-h-28 items-center justify-center gap-2 text-sm text-muted">
          <LoaderCircle className="animate-spin" size={17} />
          正在搜索 TMDB…
        </div>
      ) : !candidates.length ? (
        <div className="grid min-h-28 place-items-center px-4 text-center text-sm text-muted">
          没有找到匹配条目，请调整番剧名称后重新搜索。
        </div>
      ) : (
        candidates.map((candidate) => {
          const active = selected?.tmdb_id === candidate.tmdb_id && selected.media_type === candidate.media_type
          return (
            <NativeButton
              key={`${candidate.media_type}-${candidate.tmdb_id}`}
              type="button"
              aria-label={`${candidate.title}，${candidate.media_type === "tv" ? "电视节目" : "电影"}，TMDB #${candidate.tmdb_id}`}
              aria-pressed={active}
              onClick={() => onSelect(candidate)}
              className={[
                "flex w-full gap-3 rounded-control border p-2.5 text-left transition-colors",
                active
                  ? "border-accent bg-accent-soft ring-2 ring-accent/60"
                  : "border-transparent hover:border-border",
              ].join(" ")}
            >
              <div className="grid h-[84px] w-14 shrink-0 place-items-center overflow-hidden rounded-inset bg-surface-raised text-muted">
                {candidate.poster_url ? (
                  <img src={candidate.poster_url} alt="" className="h-full w-full object-cover" />
                ) : (
                  <ImageOff size={18} />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold text-ink">{candidate.title}</p>
                    {candidate.original_title && (
                      <p className="truncate text-[13px] text-muted">{candidate.original_title}</p>
                    )}
                  </div>
                  {active && (
                    <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent text-on-accent">
                      <Check size={14} />
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted">
                  {candidate.media_type === "tv" ? "电视节目" : "电影"} · TMDB #{candidate.tmdb_id}
                  {candidate.release_date ? ` · ${candidate.release_date}` : ""}
                </p>
                {candidate.overview && (
                  <p className="mt-1.5 line-clamp-2 text-[13px] leading-5 text-muted">{candidate.overview}</p>
                )}
              </div>
            </NativeButton>
          )
        })
      )}
    </div>
  )
}
