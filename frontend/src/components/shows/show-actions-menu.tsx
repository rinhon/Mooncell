import { useState } from "react"
import { LoaderCircle, MoreHorizontal, RefreshCw, Upload } from "lucide-react"
import { Button, NativeButton } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import type { ShowDisplayProps } from "./types"

export function ShowActionsMenu({
  show,
  onUpload,
  onRescrape,
  rescraping,
}: Pick<ShowDisplayProps, "show" | "onUpload" | "onRescrape" | "rescraping">) {
  const [activated, setActivated] = useState(false)
  const [open, setOpen] = useState(false)
  const triggerLabel = `${show.name}：更多操作`

  if (!activated) {
    return (
      <NativeButton
        type="button"
        data-slot="button"
        data-variant="ghost"
        data-size="icon-sm"
        aria-label={triggerLabel}
        aria-haspopup="menu"
        aria-expanded="false"
        className={[
          "ui-button relative isolate inline-flex size-8 shrink-0 items-center justify-center gap-2",
          "overflow-hidden whitespace-nowrap rounded-control border border-transparent bg-transparent p-0",
          "text-sm font-medium text-muted disabled:pointer-events-none disabled:opacity-50",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        ].join(" ")}
        onPointerEnter={() => setActivated(true)}
        onPointerDown={() => setActivated(true)}
        onFocus={() => setActivated(true)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
            event.preventDefault()
            setActivated(true)
            setOpen(true)
          }
        }}
        onClick={() => {
          setActivated(true)
          setOpen(true)
        }}
      >
        <MoreHorizontal size={17} />
      </NativeButton>
    )
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button size="icon-sm" variant="ghost" pressMotion={false} aria-label={triggerLabel}>
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
