import { ExternalLink, FolderOpen, MoreHorizontal, Pencil, Play, RefreshCw, Upload } from "lucide-react"
import { Link } from "react-router-dom"
import type { ShowDetail, ShowEpisode } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

type DetailAction = "folder" | "rescrape" | "refresh"
type Props = {
  show: ShowDetail
  items: ShowEpisode[]
  pending: boolean
  pendingAction?: DetailAction
  onAction: (action: DetailAction) => void
  onEdit: () => void
  onUpload: () => void
}

function playbackTarget(items: ShowEpisode[], movie: boolean) {
  const playable = items.filter((item) => item.media_id && !item.rename_pending)
  const continuing = playable.find((item) => item.progress && item.progress.position > 0 && !item.progress.completed)
  const item = continuing ?? playable.find((item) => !item.progress?.completed) ?? playable[0]
  if (!item) return null
  const episode = item.episode_start == null ? "视频" : `第 ${item.episode_start} 集`
  const label = continuing ? `继续观看${movie ? "" : ` ${episode}`}` : movie ? "播放影片" : `播放${episode}`
  return { item, label }
}

export function DetailActions({ show, items, pending, pendingAction, onAction, onEdit, onUpload }: Props) {
  const target = playbackTarget(items, show.media_type === "movie")
  const tmdb = show.tmdb_url && /^https?:\/\//i.test(show.tmdb_url) ? show.tmdb_url : undefined
  return (
    <div className="detail-primary-actions">
      {target && (
        <Button asChild icon={Play}>
          <Link
            to={`/watch/${target.item.media_id}`}
            state={{ autoPlay: true, sourceId: show.id, showTitle: show.metadata_title ?? show.name }}
            aria-label={`${target.label}：${target.item.filename}`}
          >
            {target.label}
          </Link>
        </Button>
      )}
      <Button
        variant="secondary"
        icon={FolderOpen}
        pending={pending && pendingAction === "folder"}
        disabled={pending}
        pendingLabel="打开中…"
        onClick={() => onAction("folder")}
      >
        打开文件夹
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="detail-title-menu" aria-label="作品操作" title="作品操作">
            <MoreHorizontal size={22} aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="start" animateSize>
          <DropdownMenuItem onSelect={onUpload}>
            <Upload size={16} />
            更换图片
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onEdit}>
            <Pencil size={16} />
            编辑订阅
          </DropdownMenuItem>
          <DropdownMenuItem disabled={pending || !show.tmdb_id} onSelect={() => onAction("rescrape")}>
            <RefreshCw size={16} />
            重新刮削
          </DropdownMenuItem>
          {show.subscription.kind !== "magnet" && (
            <DropdownMenuItem disabled={pending} onSelect={() => onAction("refresh")}>
              <RefreshCw size={16} />
              刷新 RSS
            </DropdownMenuItem>
          )}
          {tmdb && (
            <DropdownMenuItem asChild>
              <a href={tmdb} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={16} />在 TMDB 查看
              </a>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
