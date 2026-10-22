import { Star } from "lucide-react"
import type { ShowDetail, ShowLibrary } from "@/lib/api"

export function DetailHeader({ show, library }: { show: ShowDetail; library?: ShowLibrary }) {
  return (
    <>
      <div className="detail-kicker">
        {show.media_type === "movie" ? "电影" : show.media_type === "tv" ? "电视剧" : "媒体详情"}
        {show.tmdb_id != null && <span> · TMDB #{show.tmdb_id}</span>}
      </div>
      <div className="detail-title">
        <h1>{show.name}</h1>
      </div>
      <div className="detail-facts">
        {show.rating != null && (
          <span className="detail-rating">
            <Star size={20} fill="currentColor" />
            {show.rating.toFixed(1)}
            {show.vote_count != null && <small>（{show.vote_count} 人评分）</small>}
          </span>
        )}
        {show.release_date && <span>{show.release_date.slice(0, 4)}</span>}
        {show.media_type !== "movie" && show.episode_count != null && <span>TMDB 共 {show.episode_count} 集</span>}
        {library && <span>本地 {library.total} 个视频</span>}
      </div>
      {show.genres.length > 0 && <p className="detail-genres">{show.genres.join(" / ")}</p>}
    </>
  )
}
