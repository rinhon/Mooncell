import { memo } from "react"
import { Link } from "react-router-dom"
import { posterUrl } from "@/lib/show-artwork"
import { FadeInImage } from "@/components/ui/fade-in-image"
import { ShowCover } from "@/components/show-cover"
import type { ShowDisplayProps } from "./types"

export const ShowPosterTile = memo(function ShowPosterTile({ show, index, returnState, openDetail }: ShowDisplayProps) {
  return (
    <Link
      to={`/shows/${show.id}`}
      state={returnState}
      onClick={(event) => openDetail(event, show.id)}
      aria-label={`查看 ${show.name} 详情`}
      title={show.name}
      className="show-poster-tile ring-1 ring-island-border hover:ring-accent/55"
    >
      {posterUrl(show) ? (
        <FadeInImage
          src={posterUrl(show)!}
          alt={`${show.name} 海报`}
          loading={index === 0 ? "eager" : "lazy"}
          fetchPriority={index === 0 ? "high" : "auto"}
          className="size-full object-cover"
          fallback={<ShowCover title={show.name} />}
        />
      ) : (
        <ShowCover title={show.name} />
      )}
      <div className="media-scrim" aria-hidden="true" />
      <span className="show-poster-caption">
        <strong>{show.name}</strong>
        <small>已发现 {show.discovered_items} 条发布</small>
      </span>
    </Link>
  )
})
