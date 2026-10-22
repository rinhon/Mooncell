import { useRef, useState, type MouseEvent } from "react"
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query"
import type { ClickSparkHandle } from "@/components/click-spark"
import { useToast } from "@/components/ui/toast"
import { api } from "@/lib/api"
import type { CalendarItem, SeasonCalendar } from "./types"

export function useCalendarFavorite(reducedMotion: boolean | null) {
  const queryClient = useQueryClient()
  const sparksRef = useRef<ClickSparkHandle>(null)
  const savingFavorites = useIsMutating({ mutationKey: ["calendar-favorite"] })
  const pendingFavorites = useRef(new Set<string>())
  const animatingFavorites = useRef(new Set<string>())
  const [favoriteOrder, setFavoriteOrder] = useState<Record<string, boolean>>({})
  const toast = useToast()
  function updateFavorite(input: { season: string; id: number; liked: boolean }) {
    queryClient.setQueriesData<SeasonCalendar>({ queryKey: ["season-calendar"] }, (old) =>
      old?.season === input.season
        ? { ...old, items: old.items.map((item) => (item.id === input.id ? { ...item, liked: input.liked } : item)) }
        : old,
    )
  }
  const favorite = useMutation({
    mutationKey: ["calendar-favorite"],
    mutationFn: (input: { season: string; id: number; liked: boolean }) =>
      api(`/calendar/${input.season}/items/${input.id}/favorite`, {
        method: "PUT",
        body: JSON.stringify({ liked: input.liked }),
      }),
    onMutate: (input) => {
      void queryClient.cancelQueries({ queryKey: ["season-calendar"] })
      updateFavorite(input)
    },
    onError: (error, input) => {
      // 仅回退失败的卡片，不覆盖其他同时保存的收藏。
      updateFavorite({ ...input, liked: !input.liked })
      toast("喜欢状态保存失败", { description: error.message, tone: "error" })
    },
    onSettled: (_result, _error, input) => {
      pendingFavorites.current.delete(`${input.season}-${input.id}`)
      if (queryClient.isMutating({ mutationKey: ["calendar-favorite"] }) === 1) {
        void queryClient.invalidateQueries({ queryKey: ["season-calendar"] })
      }
    },
  })
  function toggleFavorite(season: string, item: CalendarItem, event: MouseEvent<HTMLButtonElement>) {
    const key = `${season}-${item.id}`
    if (pendingFavorites.current.has(key) || animatingFavorites.current.has(key)) return
    if (!item.liked && !reducedMotion) {
      const rect = event.currentTarget.getBoundingClientRect()
      // Keep the card in place until its entire spark burst has finished.
      animatingFavorites.current.add(key)
      setFavoriteOrder((previous) => ({ ...previous, [key]: item.liked }))
      sparksRef.current?.sparkAt(rect.left + rect.width / 2, rect.top + rect.height / 2, () => {
        animatingFavorites.current.delete(key)
        setFavoriteOrder((previous) => {
          const next = { ...previous }
          delete next[key]
          return next
        })
      })
    }
    pendingFavorites.current.add(key)
    favorite.mutate({ season, id: item.id, liked: !item.liked })
  }

  const isFavoriteBusy = (season: string, id: number) => {
    const key = `${season}-${id}`
    return pendingFavorites.current.has(key) || animatingFavorites.current.has(key)
  }
  return { sparksRef, savingFavorites, favoriteOrder, toggleFavorite, isFavoriteBusy }
}
