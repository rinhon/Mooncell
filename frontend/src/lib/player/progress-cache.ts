import type { QueryClient } from "@tanstack/react-query"
import type { PlaybackProgress, ShowLibrary } from "@/lib/api"

export async function syncPlaybackProgress(
  client: QueryClient,
  sourceId: number,
  mediaId: string,
  progress: PlaybackProgress,
) {
  const queryKey = ["shows", "library", sourceId]
  // 返回详情时的读取可能先于最后一次保存完成，先取消旧读取，再更新并重新获取。
  await client.cancelQueries({ queryKey, exact: true })
  client.setQueryData<ShowLibrary>(queryKey, (library) => {
    if (!library) return library
    return {
      ...library,
      seasons: library.seasons.map((season) => ({
        ...season,
        items: season.items.map((item) => {
          if (item.media_id !== mediaId) return item
          const cachedAt = Date.parse(item.progress?.updated_at ?? "")
          const savedAt = Date.parse(progress.updated_at ?? "")
          if (Number.isFinite(cachedAt) && Number.isFinite(savedAt) && cachedAt > savedAt) return item
          return { ...item, progress }
        }),
      })),
    }
  })
  await client.invalidateQueries({ queryKey, exact: true })
}
