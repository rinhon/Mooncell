import { motion, useReducedMotion } from "motion/react"
import { Link } from "react-router-dom"
import { posterUrl } from "@/lib/show-artwork"
import { spring } from "@/lib/motion"
import { BlurFade } from "@/components/ui/blur-fade"
import { FadeInImage } from "@/components/ui/fade-in-image"
import { ShowCover } from "@/components/show-cover"
import type { ShowDisplayProps } from "./types"

export function ShowPosterTile({ show, index, detailState, openDetail }: ShowDisplayProps) {
  const reducedMotion = useReducedMotion()
  return (
    <BlurFade className="min-w-0" delay={(index % 5) * 0.08} duration={0.4} offset={8} inView inViewMargin="0px">
      <motion.div
        whileHover={reducedMotion ? undefined : { y: -5, scale: 1.015 }}
        transition={spring.snappy}
        className="transform-gpu"
      >
        <Link
          to={`/shows/${show.id}`}
          state={detailState()}
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
      </motion.div>
    </BlurFade>
  )
}
