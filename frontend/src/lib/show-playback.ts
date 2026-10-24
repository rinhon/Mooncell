import type { ShowEpisode } from "@/lib/api"

export function playbackTarget(items: ShowEpisode[], movie: boolean) {
  const playable = items.filter((item) => item.media_id && !item.rename_pending)
  let latestIndex = -1
  let latestTime = -Infinity
  for (const [index, item] of playable.entries()) {
    if (!item.progress || (item.progress.position <= 0 && !item.progress.completed)) continue
    const updatedAt = Date.parse(item.progress.updated_at ?? "")
    const time = Number.isFinite(updatedAt) ? updatedAt : -Infinity
    // 按最后观看时间选集；旧记录没有有效时间时保持列表顺序。
    if (latestIndex < 0 || time > latestTime) {
      latestIndex = index
      latestTime = time
    }
  }
  const latest = playable[latestIndex]
  const item = latest?.progress?.completed
    ? (playable.slice(latestIndex + 1).find((episode) => !episode.progress?.completed) ?? latest)
    : (latest ?? playable[0])
  if (!item) return null
  const continuing = item.progress && item.progress.position > 0 && !item.progress.completed
  const episode = item.episode_start == null ? "视频" : `第 ${item.episode_start} 集`
  const label = continuing ? `继续观看${movie ? "" : ` ${episode}`}` : movie ? "播放影片" : `播放${episode}`
  return { item, label }
}
