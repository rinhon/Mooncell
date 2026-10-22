import type { MouseEvent } from "react"
import type { Show } from "@/lib/api"
import type { ShowReturnState } from "@/lib/show-artwork"

export type ShowDisplayProps = {
  show: Show
  index: number
  columns: number
  detailState: () => ShowReturnState
  openDetail: (event: MouseEvent<HTMLAnchorElement>, id: number) => void
  onUpload: (id: number) => void
  onRescrape: (id: number) => void
  rescraping: boolean
  onItems: (show: Show) => void
  onOpenFolder: (id: number) => void
  openingFolder: boolean
}
