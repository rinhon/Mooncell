import { Link } from "react-router-dom"
import { FolderOpen, Star } from "lucide-react"
import { artworkUrl, posterUrl } from "@/lib/show-artwork"
import { ActionButton } from "@/components/ui/action-button"
import { BlurFade } from "@/components/ui/blur-fade"
import { FadeInImage } from "@/components/ui/fade-in-image"
import { Card, CardContent } from "@/components/ui/card"
import { ShowCover } from "@/components/show-cover"
import { DiscoveredItemsButton, TmdbLink } from "./show-metadata"
import { ShowActionsMenu } from "./show-actions-menu"
import type { ShowDisplayProps } from "./types"

export function ShowCard(props: ShowDisplayProps) {
  const { show, index, columns, detailState, openDetail, onItems, onOpenFolder, openingFolder } = props
  return (
    <BlurFade
      className="show-card-reveal min-w-0"
      delay={(index % columns) * 0.08}
      duration={0.4}
      offset={8}
      inView
      inViewMargin="0px"
    >
      <div className="h-full">
        <Card
          className={[
            "group flex h-full min-w-0 flex-col overflow-hidden rounded-card border-island-border bg-surface",
            "shadow-[var(--island-shadow)] transition-colors duration-200 hover:border-accent/45",
          ].join(" ")}
        >
          <Link
            to={`/shows/${show.id}`}
            state={detailState()}
            onClick={(event) => openDetail(event, show.id)}
            className="relative block h-56 shrink-0 overflow-hidden bg-[var(--skeleton)]"
          >
            {show.fanart_ready && (
              <FadeInImage
                src={artworkUrl(show, "fanart")}
                alt=""
                loading={index < columns ? "eager" : "lazy"}
                fetchPriority={index === 0 ? "high" : "auto"}
                className="absolute inset-0 size-full object-cover transform-gpu"
              />
            )}
            <div className="media-scrim media-scrim--hero z-[1]" aria-hidden="true" />
            <div className="absolute inset-x-4 bottom-4 z-[2] flex items-end gap-4">
              <div className="h-32 w-22 shrink-0 overflow-hidden rounded-control bg-surface-raised shadow-2xl ring-1 ring-white/25">
                {posterUrl(show) ? (
                  <FadeInImage
                    src={posterUrl(show)!}
                    alt={`${show.name} 海报`}
                    loading={index < columns ? "eager" : "lazy"}
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
                  <div className="mb-3 h-12 max-w-48">
                    <FadeInImage
                      src={artworkUrl(show, "clearlogo")}
                      alt=""
                      loading={index < columns ? "eager" : "lazy"}
                      className="h-full max-w-full object-contain object-left drop-shadow"
                    />
                  </div>
                )}
                <p className="line-clamp-2 text-lg font-semibold leading-tight">{show.name}</p>
                {show.metadata_title && show.metadata_title !== show.name && (
                  <p className="mt-1 truncate text-xs text-white/75">{show.metadata_title}</p>
                )}
              </div>
            </div>
          </Link>
          <CardContent className="flex flex-1 flex-col p-5">
            <div className="flex items-center gap-2">
              {show.tmdb_id && <TmdbLink show={show} />}
              {show.rating != null && (
                <span className="flex items-center gap-1 text-xs text-muted">
                  <Star size={13} className="fill-amber-400 text-amber-400" />
                  {show.rating.toFixed(1)}
                </span>
              )}
              <div className="ml-auto">
                <ShowActionsMenu {...props} />
              </div>
            </div>
            <p className="mt-4 line-clamp-3 min-h-18 whitespace-pre-line break-words text-sm leading-6 text-muted">
              {show.overview || "暂无剧情简介"}
            </p>
            <div className="mt-auto pt-4">
              <div className="grid grid-cols-2 gap-3 rounded-control border border-border-soft bg-surface p-3 text-xs">
                <div>
                  <p className="text-muted">已发现发布</p>
                  <div className="mt-1">
                    <DiscoveredItemsButton show={show} onClick={() => onItems(show)} />
                  </div>
                </div>
                <div>
                  <p className="text-muted">TMDB 集数</p>
                  <p className="mt-1 font-semibold">{show.episode_count ?? "未知"}</p>
                </div>
              </div>
            </div>
            <ActionButton
              icon={FolderOpen}
              emphasis="secondary"
              className="mt-4 w-full"
              pending={openingFolder}
              pendingLabel="打开中…"
              onClick={() => onOpenFolder(show.id)}
            >
              打开文件夹
            </ActionButton>
          </CardContent>
        </Card>
      </div>
    </BlurFade>
  )
}
