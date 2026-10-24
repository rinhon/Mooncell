import type { ArtworkKind, Show } from "@/lib/api"

export const artworkVersion = (show: Show, kind: ArtworkKind) =>
  show.artwork_versions?.[kind] ?? show.artwork_version ?? ""

export const artworkUrl = (show: Show, kind: ArtworkKind) =>
  `/api/v1/shows/${show.id}/artwork/${kind}?v=${encodeURIComponent(artworkVersion(show, kind))}`

export const posterUrl = (show: Show) => (show.poster_ready ? artworkUrl(show, "poster") : show.poster_url || undefined)

export type ShowsView = "cards" | "posters" | "list"
export type ShowReturnState = { from: string; view?: ShowsView; scrollY?: number }
export function showReturnState(state: unknown): ShowReturnState {
  if (
    state &&
    typeof state === "object" &&
    "from" in state &&
    typeof state.from === "string" &&
    /^\/shows(?:\?[^#]*)?$/.test(state.from)
  ) {
    const value = state as ShowReturnState
    return {
      from: value.from,
      view: value.view === "list" || value.view === "posters" ? value.view : "cards",
      scrollY: typeof value.scrollY === "number" && Number.isFinite(value.scrollY) ? Math.max(0, value.scrollY) : 0,
    }
  }
  return { from: "/shows" }
}
