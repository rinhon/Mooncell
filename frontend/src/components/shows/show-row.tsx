import { memo, useContext } from "react"
import { PageMotionContext } from "@/lib/page-motion"
import { motion, useReducedMotion } from "motion/react"
import { Link } from "react-router-dom"
import { FolderOpen, Star } from "lucide-react"
import { posterUrl } from "@/lib/show-artwork"
import { spring } from "@/lib/motion"
import { ActionButton } from "@/components/ui/action-button"
import { FadeInImage } from "@/components/ui/fade-in-image"
import { Card } from "@/components/ui/card"
import { ShowCover } from "@/components/show-cover"
import { DiscoveredItemsButton, TmdbLink } from "./show-metadata"
import { ShowActionsMenu } from "./show-actions-menu"
import type { ShowDisplayProps } from "./types"

export const ShowRow = memo(function ShowRow(props: ShowDisplayProps) {
  const { show, index, returnState, openDetail, onItems, onOpenFolder, openingFolder } = props
  const reducedMotion = useReducedMotion()
  const { animateEntry } = useContext(PageMotionContext)
  return (
    <motion.li
      initial={reducedMotion || !animateEntry ? false : { opacity: 0, y: 18 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.15 }}
      transition={reducedMotion ? { duration: 0 } : { ...spring.gentle, delay: Math.min(index, 6) * 0.06 }}
    >
      <Card className="show-row-card">
        <Link
          to={`/shows/${show.id}`}
          state={returnState}
          onClick={(event) => openDetail(event, show.id)}
          aria-label={`查看 ${show.name} 详情`}
          className="show-row-poster"
        >
          {posterUrl(show) ? (
            <FadeInImage
              src={posterUrl(show)!}
              alt=""
              loading={index === 0 ? "eager" : "lazy"}
              fetchPriority={index === 0 ? "high" : "auto"}
              className="size-full object-cover"
              fallback={<ShowCover title={show.name} />}
            />
          ) : (
            <ShowCover title={show.name} />
          )}
        </Link>
        <div className="min-w-0">
          <h2 className="line-clamp-2 break-words text-base font-semibold leading-snug" title={show.name}>
            <Link to={`/shows/${show.id}`} state={returnState} onClick={(event) => openDetail(event, show.id)}>
              {show.name}
            </Link>
          </h2>
          {show.metadata_title !== show.name && (
            <p className="mt-1 truncate text-[13px] text-muted">{show.metadata_title || "未关联元数据"}</p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted">
            {show.tmdb_id && <TmdbLink show={show} />}
            {show.rating != null && (
              <span className="flex items-center gap-1">
                <Star size={13} className="fill-amber-400 text-amber-400" />
                {show.rating.toFixed(1)}
              </span>
            )}
            <span>TMDB 集数 {show.episode_count ?? "未知"}</span>
          </div>
        </div>
        <div className="show-row-footer">
          <div className="show-row-discovered">
            <p className="text-xs text-muted">已发现发布</p>
            <div className="mt-1 text-sm">
              <DiscoveredItemsButton show={show} onClick={() => onItems(show)} />
            </div>
          </div>
          <div className="show-row-actions">
            <ActionButton
              icon={FolderOpen}
              emphasis="secondary"
              size="sm"
              pending={openingFolder}
              pendingLabel="打开中…"
              onClick={() => onOpenFolder(show.id)}
            >
              文件夹
            </ActionButton>
            <ShowActionsMenu {...props} />
          </div>
        </div>
      </Card>
    </motion.li>
  )
})
