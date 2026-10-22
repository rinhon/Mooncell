import { ArrowRight, CheckCircle2, Copy, FileWarning, FolderInput, Link2, RotateCcw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { DemoIndicator } from "@/components/demo-indicator"
import { PageHeading } from "@/components/page-heading"
import { useDemoData } from "@/hooks/use-demo-data"

export function OrganizerPage() {
  const tasks = useDemoData().organizeTasks
  return <><PageHeading eyebrow="Library pipeline" title="整理中心" description="预览源文件与目标路径，检查冲突，并追踪每一次可重试的整理操作。" action={<DemoIndicator/>}/>
    <div className="grid gap-4">{tasks.map((task) => <Card key={task.id} className={task.status === "conflict" ? "border-[var(--warning-line)]" : ""}><CardHeader><div className="flex items-center gap-3"><span className={`grid size-10 place-items-center rounded-[var(--radius-control)] ${task.status === "completed" ? "bg-[var(--accent-soft)] text-[var(--accent)]" : task.status === "conflict" ? "bg-[var(--warning-soft)] text-[var(--warning)]" : "bg-[var(--surface-raised)] text-[var(--muted)]"}`}>{task.status === "completed" ? <CheckCircle2 size={18}/> : task.status === "conflict" ? <FileWarning size={18}/> : <FolderInput size={18}/>}</span><div><CardTitle>{task.title} · E{String(task.episode).padStart(2,"0")}</CardTitle><CardDescription>{task.updatedAt}</CardDescription></div></div><Badge tone={task.status === "completed" ? "success" : task.status === "conflict" ? "warning" : "neutral"}>{task.status === "completed" ? "已完成" : task.status === "conflict" ? "冲突" : "待整理"}</Badge></CardHeader><CardContent><div className="grid items-center gap-3 lg:grid-cols-[1fr_auto_1fr]"><PathBox label="源文件" value={task.sourcePath}/><ArrowRight className="mx-auto hidden text-[var(--muted)] lg:block" size={18}/><PathBox label="目标路径" value={task.targetPath}/></div><div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] pt-4"><p className="flex items-center gap-2 text-[13px] text-[var(--muted)]">{task.strategy === "硬链接" ? <Link2 size={14}/> : <Copy size={14}/>}策略：{task.strategy} · 禁止覆盖 · 幂等执行</p>{task.status === "conflict" && <div className="flex gap-2"><Button size="sm" variant="secondary">查看冲突</Button><Button size="sm"><RotateCcw size={14}/>重新生成计划</Button></div>}</div></CardContent></Card>)}</div>
  </>
}

function PathBox({ label, value }: { label: string; value: string }) { return <div className="min-w-0 rounded-[var(--radius-inset)] bg-[var(--surface)] border border-[var(--border-soft)] p-3 text-xs"><p className="mb-1 text-[var(--muted)]">{label}</p><p className="break-all font-mono leading-5 text-[var(--muted)]">{value}</p></div> }
