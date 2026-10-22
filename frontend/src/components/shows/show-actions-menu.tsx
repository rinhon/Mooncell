import { LoaderCircle, MoreHorizontal, RefreshCw, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import type { ShowDisplayProps } from "./types"

export function ShowActionsMenu({
  show,
  onUpload,
  onRescrape,
  rescraping,
}: Pick<ShowDisplayProps, "show" | "onUpload" | "onRescrape" | "rescraping">) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon-sm" variant="ghost" pressMotion={false} aria-label={`${show.name}：更多操作`}>
          <MoreHorizontal size={17} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" animateSize>
        <DropdownMenuItem onSelect={() => onUpload(show.id)}>
          <Upload size={15} />
          更换图片
        </DropdownMenuItem>
        <DropdownMenuItem disabled={rescraping} onSelect={() => onRescrape(show.id)}>
          {rescraping ? <LoaderCircle size={15} className="animate-spin" /> : <RefreshCw size={15} />}重新刮削
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
