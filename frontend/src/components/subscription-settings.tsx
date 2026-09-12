import { useState, type FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Save } from "lucide-react"
import { api } from "@/lib/api"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Field } from "@/components/field"
import { Input } from "@/components/ui/input"
import { ActionButton } from "@/components/ui/action-button"
import { useToast } from "@/components/ui/toast"

type Options = { proxy_url: string | null; refresh_interval_minutes: number }

export function SubscriptionSettingsSection() {
  const client = useQueryClient()
  const toast = useToast()
  const query = useQuery({ queryKey: ["subscription-settings"], queryFn: () => api<Options>("/settings/subscriptions") })
  const [draft, setDraft] = useState<{ proxy: string; interval: string } | null>(null)
  const form = draft ?? { proxy: query.data?.proxy_url ?? "", interval: String(query.data?.refresh_interval_minutes ?? 5) }
  const save = useMutation({
    mutationFn: () => api<Options>("/settings/subscriptions", { method: "PATCH", body: JSON.stringify({ proxy_url: form.proxy.trim() || null, refresh_interval_minutes: Number(form.interval) }) }),
    onSuccess: (data) => {
      client.setQueryData(["subscription-settings"], data)
      void client.invalidateQueries({ queryKey: ["feeds"] })
      setDraft(null)
      toast("订阅设置已保存")
    },
    onError: (error) => toast("订阅设置保存失败", { description: error.message, tone: "error" }),
  })
  function submit(event: FormEvent) { event.preventDefault(); save.mutate() }
  return <Card><CardHeader><div><CardTitle>订阅连接与刷新</CardTitle><CardDescription>统一设置所有订阅的连接方式与自动刷新频率。</CardDescription></div></CardHeader><CardContent>
    {query.isPending ? <p role="status" className="text-sm text-[var(--muted)]">正在读取订阅设置…</p> : query.isError ? <p role="alert" className="text-sm text-[var(--danger)]">读取失败：{query.error.message}<button className="ml-3 underline" onClick={() => void query.refetch()}>重试</button></p> : <form onSubmit={submit} className="grid gap-4">
      <Field label="订阅代理地址" hint="仅用于 RSS 解析和刷新，不影响 TMDB、图片或下载器连接。支持 HTTP / HTTPS 代理；留空直连。"><Input type="url" value={form.proxy} disabled={save.isPending} onChange={(event) => setDraft({ ...form, proxy: event.target.value })} placeholder="http://127.0.0.1:7890"/></Field>
      <Field label="自动刷新间隔（分钟）" hint="支持 1–1440 分钟，默认 5 分钟。应用于已有及新增订阅，停用的订阅不会自动刷新。"><Input type="number" min={1} max={1440} step={1} required value={form.interval} disabled={save.isPending} onChange={(event) => setDraft({ ...form, interval: event.target.value })}/></Field>
      <div className="flex justify-end"><ActionButton type="submit" icon={Save} pending={save.isPending} pendingLabel="保存中…">保存订阅设置</ActionButton></div>
    </form>}
  </CardContent></Card>
}
