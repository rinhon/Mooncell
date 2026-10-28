import { useRef, useState } from "react"
import { ChevronDown, Pause } from "lucide-react"
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

const MAX_SELECTION = 100

type Props = {
  feeds: Feed[]
  pending: boolean
  disabled?: boolean
  onStop: (sourceIds: number[]) => Promise<unknown>
}

export function BatchStopMenu({ feeds, pending, disabled = false, onStop }: Props) {
  const [open, setOpen] = useState(false)
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const available = feeds.filter((feed) => feed.active)
  const availableIds = new Set(available.map((feed) => feed.id))
  const selected = selectedIds.filter((id) => availableIds.has(id))
  const selectedSet = new Set(selected)
  const busy = pending || submitting
  const blocked = disabled || busy

  function changeOpen(next: boolean) {
    if (busy) return
    if (next) setSelectedIds([])
    setOpen(next)
  }

  function toggle(id: number) {
    if (blocked) return
    setSelectedIds((current) => {
      const active = current.filter((value) => availableIds.has(value))
      if (active.includes(id)) return active.filter((value) => value !== id)
      return active.length < MAX_SELECTION ? [...active, id] : active
    })
  }

  async function submit() {
    if (blocked || submittingRef.current || !selected.length) return
    submittingRef.current = true
    setSubmitting(true)
    try {
      await onStop(selected)
      setOpen(false)
      setSelectedIds([])
    } catch {
      // 调用方展示失败提示，保留当前选择以便重试。
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button ref={triggerRef} variant="secondary" disabled={blocked || !available.length}>
            批量操作
            <ChevronDown size={16} aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onCloseAutoFocus={(event) => {
            if (open) event.preventDefault()
          }}
        >
          <DropdownMenuItem disabled={blocked || !available.length} onSelect={() => changeOpen(true)}>
            <Pause size={15} aria-hidden="true" />
            停止订阅
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent
          className="max-w-xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            triggerRef.current?.focus()
          }}
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault()
          }}
          onInteractOutside={(event) => {
            if (busy) event.preventDefault()
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            <DialogHeader>
              <DialogTitle>批量停止订阅</DialogTitle>
              <DialogDescription>选择要停止的订阅，订阅记录和已有文件会保留。</DialogDescription>
            </DialogHeader>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted" role="status" aria-live="polite">
                已选 {selected.length} 个，共 {available.length} 个可停止
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={blocked || !available.length}
                  onClick={() => setSelectedIds(available.slice(0, MAX_SELECTION).map((feed) => feed.id))}
                >
                  {available.length > MAX_SELECTION ? "选择前 100 个" : "全选"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={blocked || !selected.length}
                  onClick={() => setSelectedIds([])}
                >
                  清空
                </Button>
              </div>
            </div>
            {available.length > MAX_SELECTION && <p className="mb-3 text-xs text-muted">每次最多停止 100 个订阅。</p>}
            <div
              role="group"
              aria-label="选择要停止的订阅"
              className="max-h-[min(45vh,24rem)] overflow-y-auto overscroll-contain rounded-card border border-border"
            >
              {available.length ? (
                available.map((feed) => {
                  const checked = selectedSet.has(feed.id)
                  const inactive = blocked || (!checked && selected.length >= MAX_SELECTION)
                  return (
                    <label
                      key={feed.id}
                      className={[
                        "flex items-start gap-3 border-b border-border-soft px-4 py-3 last:border-b-0",
                        inactive ? "cursor-default opacity-50" : "cursor-pointer hover:bg-hover-background",
                      ].join(" ")}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={inactive}
                        onChange={() => toggle(feed.id)}
                        className="mt-0.5 size-4 shrink-0 cursor-inherit rounded-xs accent-[var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      />
                      <span className="min-w-0 break-words text-sm leading-5 [overflow-wrap:anywhere]">
                        {feed.name}
                      </span>
                    </label>
                  )
                })
              ) : (
                <p className="px-4 py-6 text-center text-sm text-muted">当前没有可停止的订阅。</p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="secondary" disabled={busy} onClick={() => changeOpen(false)}>
                取消
              </Button>
              <Button
                type="submit"
                icon={Pause}
                disabled={disabled || !selected.length}
                pending={busy}
                pendingLabel="停止中…"
              >
                停止所选（{selected.length}）
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
