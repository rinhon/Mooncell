import type { MouseEvent } from "react"
import { motion, useReducedMotion } from "motion/react"
import { Heart, ImageOff } from "lucide-react"
import { spring } from "@/lib/motion"
import { mikanSearchUrl } from "@/lib/mikan"
import { Skeleton } from "@/components/ui/skeleton"
import { FadeInImage } from "@/components/ui/fade-in-image"
import type { CalendarItem } from "./types"

function Cover({ item, priority }: { item: CalendarItem; priority: boolean }) {
  const fallback = <ImageOff size={24} strokeWidth={1} role="img" aria-label="暂无封面" />
  return (
    <div className="calendar-cover">
      {item.cover_url ? (
        <FadeInImage
          src={item.cover_url}
          alt={item.title}
          loading={priority ? "eager" : "lazy"}
          fetchPriority={priority ? "high" : "auto"}
          placeholder={<Skeleton className="calendar-cover-skeleton" />}
          fallback={fallback}
        />
      ) : (
        fallback
      )}
      <div className="media-scrim z-[1]" aria-hidden="true" />
    </div>
  )
}

export function CalendarItemCard({
  item,
  priority,
  favoriteDisabled,
  onFavorite,
}: {
  item: CalendarItem
  priority: boolean
  favoriteDisabled: boolean
  onFavorite: (event: MouseEvent<HTMLButtonElement>) => void
}) {
  const reducedMotion = useReducedMotion()
  return (
    <motion.article
      layout={reducedMotion ? false : "position"}
      transition={{ layout: spring.layout }}
      className="calendar-item"
      style={{ position: "relative", zIndex: item.liked ? 1 : 0 }}
    >
      <div className="calendar-artwork">
        <a
          className="calendar-search-link"
          href={mikanSearchUrl(item.title)}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`在蜜柑计划搜索：${item.title}（新标签页）`}
          title={`在蜜柑计划搜索：${item.title}`}
        >
          <Cover item={item} priority={priority} />
        </a>
        <button
          type="button"
          className="calendar-favorite"
          aria-pressed={Boolean(item.liked)}
          aria-label={`${item.liked ? "取消喜欢" : "喜欢"}：${item.title}`}
          title={item.liked ? "取消喜欢" : "喜欢并置顶"}
          aria-disabled={favoriteDisabled}
          onClick={onFavorite}
        >
          <Heart size={17} fill={item.liked ? "currentColor" : "none"} />
        </button>
      </div>
      <div className="calendar-item-copy">
        <p className="calendar-time">{item.broadcast_time}</p>
        <h4 title={item.title}>
          <a
            className="calendar-title-link"
            href={mikanSearchUrl(item.title)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`在蜜柑计划搜索：${item.title}（新标签页）`}
          >
            {item.title}
          </a>
        </h4>
      </div>
    </motion.article>
  )
}
