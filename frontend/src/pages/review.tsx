import { useEffect, useState } from "react"
import { Check, FileSearch, RotateCcw, Trash2, TriangleAlert } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ActionButton } from "@/components/ui/action-button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { DemoIndicator } from "@/components/demo-indicator"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field } from "@/components/field"
import { Input } from "@/components/ui/input"
import { PageHeading } from "@/components/page-heading"
import { useToast } from "@/components/ui/toast"
import { useDemoData } from "@/hooks/use-demo-data"
import type { DemoReview } from "@/mocks/demo-data"

/** 收容不能安全自动处理的发布，避免错误条目被盲目下载。 */
export function ReviewPage() {
  const toast = useToast()
  const demo = useDemoData()
  const [items, setItems] = useState<DemoReview[]>([])
  const [editing, setEditing] = useState<DemoReview | null>(null)
  const [season, setSeason] = useState("1")
  const [episode, setEpisode] = useState("")
  useEffect(() => { setItems(demo.reviews) }, [demo.reviews])
  function remove(id: string, action: string) { setItems((current) => current.filter((item) => item.id !== id)); toast(action, { description: "该决定已写入演示审计记录。" }) }
  return <><PageHeading eyebrow="Human in the loop" title="审核收件箱" description="集中处理低置信度、合集、Special 和路径冲突；未经批准不会继续自动操作。" action={<div className="flex items-center gap-2"><DemoIndicator/><Badge tone={items.length ? "warning" : "success"}>{items.length} 项待处理</Badge></div>}/>
    <div className="grid gap-4">{items.map((item) => <Card key={item.id} className="border-amber-200/70"><CardHeader><div className="flex items-start gap-3"><span className="grid size-10 shrink-0 place-items-center text-[var(--warning)]"><TriangleAlert size={18}/></span><div><div className="flex flex-wrap items-center gap-2"><CardTitle>{item.parsedTitle}</CardTitle><Badge tone="warning">{item.reason}</Badge><Badge>{Math.round(item.confidence * 100)}%</Badge></div><CardDescription className="mt-2 break-all">{item.rawTitle}</CardDescription></div></div></CardHeader><CardContent><div className="grid gap-4 lg:grid-cols-2"><div className="rounded-xl bg-[var(--surface)]/20 p-4 ring-1 ring-[var(--border)]"><p className="text-xs font-semibold text-[var(--muted)]">解析证据</p><div className="mt-3 grid gap-2">{item.evidence.map((value) => <p key={value} className="flex gap-2 text-sm text-[var(--muted)]"><Check size={15} className="mt-0.5 text-[var(--accent)]"/>{value}</p>)}</div><p className="mt-3 text-sm text-[var(--warning)]">{item.warning}</p></div><div className="rounded-xl bg-[var(--surface)]/20 p-4 ring-1 ring-[var(--border)]"><p className="text-xs font-semibold text-[var(--muted)]">拟执行路径</p><p className="mt-3 break-all font-mono text-xs leading-6 text-[var(--ink)]">{item.proposedPath}</p></div></div><div className="mt-4 flex flex-wrap justify-end gap-2"><ActionButton icon={Trash2} pendingLabel="忽略中…" emphasis="secondary" onClick={() => remove(item.id, "已忽略条目")}>忽略</ActionButton><ActionButton icon={RotateCcw} pendingLabel="解析中…" emphasis="secondary">重新解析</ActionButton><ActionButton icon={FileSearch} pendingLabel="处理中…" onClick={() => { setEditing(item); setEpisode(item.reason === "低置信度" ? "4" : "") }}>修正并批准</ActionButton></div></CardContent></Card>)}</div>
    <Dialog open={Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)}><DialogContent className="max-w-lg"><DialogHeader><DialogTitle>修正季与集数</DialogTitle><DialogDescription>{editing?.rawTitle}</DialogDescription></DialogHeader><div className="grid grid-cols-2 gap-3"><Field label="季度"><Input type="number" value={season} onChange={(event) => setSeason(event.target.value)}/></Field><Field label="集数"><Input type="number" step="0.5" value={episode} onChange={(event) => setEpisode(event.target.value)}/></Field></div><DialogFooter><Button variant="secondary" onClick={() => setEditing(null)}>取消</Button><Button onClick={() => { if (editing) remove(editing.id, `已批准 S${season.padStart(2,"0")}E${episode.padStart(2,"0")}`); setEditing(null) }}>批准并继续</Button></DialogFooter></DialogContent></Dialog>
  </>
}
