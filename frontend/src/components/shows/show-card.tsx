import { memo } from "react"
import { Link } from "react-router-dom"
import { FolderOpen, LoaderCircle, Star } from "lucide-react"
import { artworkUrl, posterUrl } from "@/lib/show-artwork"
import { NativeButton } from "@/components/ui/button"
import { FadeInImage } from "@/components/ui/fade-in-image"
import { Card, CardContent } from "@/components/ui/card"
import { ShowCover } from "@/components/show-cover"
import { DiscoveredItemsButton, TmdbLink } from "./show-metadata"
import { ShowActionsMenu } from "./show-actions-menu"
import type { ShowDisplayProps } from "./types"

export const ShowCard = memo(function ShowCard(props: ShowDisplayProps) {
  const { show, index, returnState, openDetail, onItems, onOpenFolder, openingFolder } = props
  return (
    <div className="show-card-reveal min-w-0">
      <div className="h-full">
        <Card
          className={[
            "group flex h-[440px] min-w-0 flex-col overflow-hidden rounded-card border-island-border bg-surface",
            "shadow-[var(--island-shadow)] transition-colors duration-200 hover:border-accent/45",
          ].join(" ")}
        >
          <Link
            to={`/shows/${show.id}`}
            state={returnState}
            onClick={(event) => openDetail(event, show.id)}
            aria-label={`查看 ${show.name} 详情`}
            title={show.name}
            className="relative block h-40 shrink-0 overflow-hidden bg-[var(--skeleton)]"
          >
            {show.fanart_ready && (
              <FadeInImage
                src={artworkUrl(show, "fanart")}
                alt=""
                loading={index === 0 ? "eager" : "lazy"}
                fetchPriority={index === 0 ? "high" : "auto"}
                className="show-card-fanart absolute inset-0 size-full object-cover transform-gpu"
              />
            )}
            <div className="media-scrim media-scrim--hero z-[1]" aria-hidden="true" />
            <div className="absolute inset-x-3 bottom-3 z-[2] flex items-end gap-3">
              <div className="h-24 w-16 shrink-0 overflow-hidden rounded-control bg-surface-raised shadow-xl ring-1 ring-white/25">
                {posterUrl(show) ? (
                  <FadeInImage
                    src={posterUrl(show)!}
                    alt={`${show.name} 海报`}
                    loading={index === 0 ? "eager" : "lazy"}
                    hoverZoom={false}
                    fetchPriority={index === 0 && !show.fanart_ready ? "high" : "auto"}
                    className="size-full object-cover"
                    fallback={<ShowCover title={show.name} />}
                  />
                ) : (
                  <ShowCover title={show.name} />
                )}
              </div>
              <div className="min-w-0 flex-1 pb-1 text-white drop-shadow-[0_2px_10px_rgba(0,0,0,0.65)]">
                {show.clearlogo_ready && (
                  <div className="mb-2 h-8 max-w-40">
                    <FadeInImage
                      src={artworkUrl(show, "clearlogo")}
                      alt=""
                      loading={index === 0 ? "eager" : "lazy"}
                      hoverZoom={false}
                      className="h-full max-w-full object-contain object-left drop-shadow"
                    />
                  </div>
                )}
                <p className="line-clamp-2 break-words text-sm font-semibold leading-5">{show.name}</p>
                {show.metadata_title && show.metadata_title !== show.name && (
                  <p className="mt-1 truncate text-xs text-white/75" title={show.metadata_title}>
                    {show.metadata_title}
                  </p>
                )}
              </div>
            </div>
          </Link>
          <CardContent className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 p-4">
            <div className="flex min-w-0 items-center gap-2">
              <div className="min-w-0 overflow-hidden [&_[data-slot=badge]]:max-w-full [&_[data-slot=badge]]:truncate [&_[data-slot=badge]]:px-1.5">
                {show.tmdb_id && <TmdbLink show={show} />}
              </div>
              {show.rating != null && (
                <span className="flex shrink-0 items-center gap-1 text-xs text-muted">
                  <Star size={13} className="fill-amber-400 text-amber-400" />
                  {show.rating.toFixed(1)}
                </span>
              )}
              <div className="ml-auto shrink-0">
                <ShowActionsMenu {...props} />
              </div>
            </div>
            <p
              className="line-clamp-3 min-h-15 whitespace-pre-line break-words text-xs leading-5 text-muted"
              title={show.overview || undefined}
            >
              {show.overview || "暂无剧情简介"}
            </p>
            <div className="mt-auto shrink-0">
              <div className="grid grid-cols-2 gap-3 rounded-control border border-border-soft bg-surface p-2.5 text-xs">
                <div className="min-w-0 break-words">
                  <p className="text-muted" title="已发现发布">
                    已发现发布
                  </p>
                  <div className="mt-1">
                    <DiscoveredItemsButton show={show} onClick={() => onItems(show)} />
                  </div>
                </div>
                <div className="min-w-0 break-words">
                  <p className="text-muted" title="TMDB 集数">
                    TMDB 集数
                  </p>
                  <p className="mt-1 font-semibold">{show.episode_count ?? "未知"}</p>
                </div>
              </div>
            </div>
            <NativeButton
              type="button"
              data-slot="button"
              data-variant="secondary"
              data-size="default"
              data-icon-slot=""
              disabled={openingFolder}
              aria-busy={openingFolder || undefined}
              onClick={() => onOpenFolder(show.id)}
              aria-label={`${show.name}：打开文件夹`}
              className={[
                "ui-button relative isolate inline-flex h-10 w-full min-w-0 shrink-0 items-center justify-center",
                "gap-2 overflow-hidden whitespace-nowrap rounded-control border border-border bg-surface px-4",
                "text-sm font-medium text-ink-2 transition-transform duration-150 active:scale-[0.97]",
                "disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2",
                "focus-visible:outline-offset-2 focus-visible:outline-accent",
              ].join(" ")}
            >
              <span className="ui-button-icon" aria-hidden="true">
                {openingFolder ? (
                  <LoaderCircle size={16} className="motion-safe:animate-spin" />
                ) : (
                  <FolderOpen size={16} />
                )}
              </span>
              {openingFolder ? "打开中…" : "打开文件夹"}
            </NativeButton>
          </CardContent>
        </Card>
      </div>
    </div>
  )
})
