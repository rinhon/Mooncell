import { NativeButton } from "@/components/ui/button"
import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, ChevronRight, Folder, FolderOpen, LoaderCircle } from "lucide-react"
import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { ActionButton } from "@/components/ui/action-button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"

type Directory = { name: string; path: string }
type Listing = { path: string | null; children: Directory[] }
export type LibraryPath = { library_root: string }

function useDirectories(path?: string, enabled = true) {
  return useQuery({
    queryKey: ["directories", path ?? null],
    queryFn: () => api<Listing>(`/filesystem/directories${path ? `?path=${encodeURIComponent(path)}` : ""}`),
    enabled,
    retry: false,
  })
}

function FolderNode({ directory, selected, onSelect }: {
  directory: Directory; selected: string; onSelect: (path: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const listing = useDirectories(directory.path, expanded)
  const active = selected === directory.path
  return <li>
    <div className={`flex items-center gap-1 rounded-sm transition-colors ${active ? "bg-white/8 text-[var(--ink)]" : "text-[var(--muted)] hover:bg-white/4"}`}>
      <NativeButton type="button" aria-label={`${expanded ? "收起" : "展开"}${directory.name}`} aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className="grid size-8 shrink-0 place-items-center rounded-sm focus-visible:outline-2">
        <ChevronRight size={14} className={`transition-transform ${expanded ? "rotate-90" : ""}`}/>
      </NativeButton>
      <NativeButton type="button" aria-pressed={active} onClick={() => onSelect(directory.path)} title={directory.path} className="flex min-w-0 flex-1 items-center gap-2 py-2 pr-3 text-left text-sm focus-visible:outline-2">
        {expanded ? <FolderOpen size={16} className="shrink-0"/> : <Folder size={16} className="shrink-0"/>}
        <span className="min-w-0 break-all">{directory.name}</span>{active && <Check size={14} className="ml-auto shrink-0"/>}
      </NativeButton>
    </div>
    {expanded && <ul className="ml-4 border-l border-[var(--border)] pl-3">
      {listing.isPending && <li className="flex items-center gap-2 px-2 py-2 text-xs text-[var(--muted)]"><LoaderCircle size={12} className="animate-spin"/>读取中…</li>}
      {listing.error && <li role="alert" className="px-2 py-2 text-xs text-[var(--danger)]">{listing.error.message}<NativeButton type="button" onClick={() => listing.refetch()} className="ml-2 underline">重试</NativeButton></li>}
      {listing.data?.children.map(child => <FolderNode key={child.path} directory={child} selected={selected} onSelect={onSelect}/>)}
      {listing.data?.children.length === 0 && <li className="px-2 py-2 text-xs text-[var(--muted)]">没有子文件夹，可选择当前文件夹</li>}
    </ul>}
  </li>
}

export function FolderPicker({ value, onSaved }: { value: string; onSaved: (path: string) => void }) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState(value)
  const client = useQueryClient()
  const roots = useDirectories(undefined, open)
  const save = useMutation({
    mutationFn: () => api<LibraryPath>("/settings/library", { method: "PATCH", body: JSON.stringify({ library_root: selected }) }),
    onSuccess: (data) => {
      client.setQueryData(["library-settings"], data)
      onSaved(data.library_root)
      setOpen(false)
    },
  })
  return <>
    <ActionButton icon={FolderOpen} emphasis="secondary" pendingLabel="读取中…" aria-haspopup="dialog" aria-expanded={open} onClick={() => { setSelected(value); save.reset(); setOpen(true) }}>选择文件夹</ActionButton>
    <Dialog open={open} onOpenChange={next => { if (!save.isPending) setOpen(next) }}>
      <DialogContent className="max-w-xl">
        <DialogHeader><DialogTitle>选择媒体库文件夹</DialogTitle><DialogDescription>浏览服务器上的文件夹，选择后保存为媒体库根目录。</DialogDescription></DialogHeader>
        <fieldset disabled={save.isPending} className="h-80 min-w-0 overflow-y-auto overflow-x-hidden rounded-sm border border-[var(--border)] bg-[var(--surface)]/30 p-3" aria-label="服务器文件夹">
          {roots.isPending && <p className="p-2 text-sm text-[var(--muted)]">正在读取磁盘…</p>}
          {roots.error && <p role="alert" className="p-2 text-sm text-[var(--danger)]">{roots.error.message}<NativeButton type="button" className="ml-2 underline" onClick={() => roots.refetch()}>重试</NativeButton></p>}
          <ul>{roots.data?.children.map(directory => <FolderNode key={directory.path} directory={directory} selected={selected} onSelect={path => { setSelected(path); save.reset() }}/>)}</ul>
        </fieldset>
        <p className="mt-4 break-all text-sm text-[var(--muted)]">所选路径：<span className="font-mono text-[var(--ink)]">{selected || "请选择文件夹"}</span></p>
        {save.error && <p role="alert" className="mt-2 text-sm text-[var(--danger)]">{save.error.message}</p>}
        <DialogFooter><Button type="button" variant="ghost" disabled={save.isPending} onClick={() => setOpen(false)}>取消</Button><Button type="button" disabled={!selected || save.isPending} onClick={() => save.mutate()}>{save.isPending ? "保存中…" : "选择并保存"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}
