import { NativeButton } from "@/components/ui/button"
import { useId, useMemo, useState } from "react"
import { useIsFetching, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, ChevronRight, Folder, FolderOpen, LoaderCircle, RefreshCw } from "lucide-react"
import { api, ApiError } from "@/lib/api"
import { directoryQueryKey, directoryQueryOptions, type Directory } from "@/lib/directories"
import { Button } from "@/components/ui/button"
import { ActionButton } from "@/components/ui/action-button"
import { BranchedMenu } from "@/components/branched-menu"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"

export type LibraryPath = { library_root: string }

function useDirectories(path?: string, enabled = true) {
  const options = useMemo(() => directoryQueryOptions(path), [path])
  const query = useQuery({ ...options, enabled })
  const directories = useMemo(() => query.data?.children ?? [], [query.data])
  return { ...query, directories }
}

function containsPath(directory: string, selected: string) {
  const base = directory.replace(/[\\/]+$/, "")
  return selected === directory || selected.startsWith(`${base}\\`) || selected.startsWith(`${base}/`)
}

function FolderBranches({ directories, selected, onSelect, visible }: {
  directories: Directory[]; selected: string; onSelect: (path: string) => void; visible: boolean
}) {
  return <BranchedMenu items={directories} getKey={directory => directory.path}
    isActive={directory => containsPath(directory.path, selected)}
    renderItem={directory => <FolderNode directory={directory} selected={selected} onSelect={onSelect} visible={visible}/>}/>
}

function FolderNode({ directory, selected, onSelect, visible }: {
  directory: Directory; selected: string; onSelect: (path: string) => void; visible: boolean
}) {
  const [expanded, setExpanded] = useState(() => containsPath(directory.path, selected))
  const childrenId = useId()
  const listing = useDirectories(directory.path, visible && expanded)
  const active = selected === directory.path
  return <>
    <div className="branched-menu-row" data-active={active} data-open={expanded}>
      <NativeButton type="button" aria-label={`选择 ${directory.name}`} aria-pressed={active} onClick={() => onSelect(directory.path)} title={directory.path} className="branched-menu-select">
        {expanded ? <FolderOpen size={16} className="shrink-0"/> : <Folder size={16} className="shrink-0"/>}
        <span>{directory.name}</span>{active && <Check size={14} className="ml-auto shrink-0"/>}
      </NativeButton>
      <NativeButton type="button" aria-label={`${expanded ? "收起" : "展开"}${directory.name}`} aria-expanded={expanded} aria-controls={childrenId} onClick={() => setExpanded(!expanded)} className="branched-menu-toggle">
        <ChevronRight size={14}/>
      </NativeButton>
    </div>
    <div id={childrenId} className="branched-menu-fold" data-open={expanded} aria-hidden={!expanded} inert={!expanded}>
      <div>
        {expanded && listing.isPending && <p role="status" className="branched-menu-status flex items-center gap-2"><LoaderCircle size={12} className="motion-safe:animate-spin"/>读取中…</p>}
        {listing.error && <p role="alert" className="branched-menu-status">{listing.error.message}<NativeButton type="button" onClick={() => listing.refetch()} className="ml-2 underline">重试</NativeButton></p>}
        {listing.data && <FolderBranches directories={listing.directories} selected={selected} onSelect={onSelect} visible={visible && expanded}/>}
        {listing.data && listing.directories.length === 0 && <p className="branched-menu-status">没有子文件夹，可选择当前文件夹</p>}
      </div>
    </div>
  </>
}

export function FolderPicker({ value, onSaved }: { value: string; onSaved: (path: string) => void }) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState(value)
  const client = useQueryClient()
  const roots = useDirectories(undefined, open)
  const refreshing = useIsFetching({ queryKey: directoryQueryKey }) > 0
  const save = useMutation({
    mutationFn: () => api<LibraryPath>("/settings/library", { method: "PATCH", body: JSON.stringify({ library_root: selected }) }),
    onSuccess: (data) => {
      client.setQueryData(["library-settings"], data)
      onSaved(data.library_root)
      setOpen(false)
    },
    onError: (error) => {
      if (error instanceof ApiError && [403, 404, 422].includes(error.status)) {
        void client.invalidateQueries({ queryKey: directoryQueryKey })
      }
    },
  })
  return <>
    <ActionButton icon={FolderOpen} emphasis="secondary" pendingLabel="读取中…" aria-haspopup="dialog" aria-expanded={open} onClick={() => { setSelected(value); save.reset(); setOpen(true) }}>选择文件夹</ActionButton>
    <Dialog open={open} onOpenChange={next => { if (!save.isPending) setOpen(next) }}>
      <DialogContent className="max-w-xl">
        <DialogHeader><DialogTitle>选择媒体库文件夹</DialogTitle><DialogDescription>点击箭头逐层展开，点击文件夹名称选择保存位置。目录有变化时可点击“刷新文件夹”。</DialogDescription></DialogHeader>
        <div className="mb-2 flex justify-end"><Button type="button" size="sm" variant="secondary" icon={RefreshCw} pending={refreshing} pendingLabel="读取中…" disabled={save.isPending} onClick={() => void client.invalidateQueries({ queryKey: directoryQueryKey })}>刷新文件夹</Button></div>
        <fieldset disabled={save.isPending} className="h-80 min-w-0 overflow-y-auto overflow-x-hidden rounded-sm border border-[var(--border)] bg-[var(--surface)]/30 p-3" aria-label="服务器文件夹">
          {roots.isPending && <p className="p-2 text-sm text-[var(--muted)]">正在读取磁盘…</p>}
          {roots.error && <p role="alert" className="p-2 text-sm text-[var(--danger)]">{roots.error.message}<NativeButton type="button" className="ml-2 underline" onClick={() => roots.refetch()}>重试</NativeButton></p>}
          {roots.data && roots.directories.length === 0 && <p className="p-2 text-sm text-[var(--muted)]">没有可访问的文件夹</p>}
          {roots.data && <FolderBranches directories={roots.directories} selected={selected} visible={open} onSelect={path => { setSelected(path); save.reset() }}/>}
        </fieldset>
        <p className="mt-4 break-all text-sm text-[var(--muted)]">所选路径：<span className="font-mono text-[var(--ink)]">{selected || "请选择文件夹"}</span></p>
        {save.error && <p role="alert" className="mt-2 text-sm text-[var(--danger)]">{save.error.message}</p>}
        <DialogFooter><Button type="button" variant="ghost" disabled={save.isPending} onClick={() => setOpen(false)}>取消</Button><Button type="button" disabled={!selected || save.isPending} onClick={() => save.mutate()}>{save.isPending ? "保存中…" : "选择并保存"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}
