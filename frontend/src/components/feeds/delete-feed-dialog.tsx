import { Trash2 } from "lucide-react"
import type { Feed } from "@/lib/api"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

export function DeleteFeedDialog({
  feed,
  pending,
  onClose,
  onConfirm,
}: {
  feed: Feed | null
  pending: boolean
  onClose: () => void
  onConfirm: (id: number) => void
}) {
  return (
    <Dialog
      open={feed !== null}
      onOpenChange={(open) => {
        if (!open && !pending) onClose()
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{feed?.kind === "magnet" ? "删除合集" : "删除订阅"}</DialogTitle>
          <DialogDescription>
            确定删除“{feed?.name}”吗？
            {feed?.kind === "magnet"
              ? "删除后停止此合集的自动整理，保留 qB 中的任务和文件。"
              : "删除后将停止从此 RSS 源发现新发布。"}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" disabled={pending} onClick={() => onClose()}>
            取消
          </Button>
          <Button
            variant="danger"
            icon={Trash2}
            pending={pending}
            pendingLabel="删除中…"
            onClick={() => feed && onConfirm(feed.id)}
          >
            {feed?.kind === "magnet" ? "删除合集" : "删除订阅"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
