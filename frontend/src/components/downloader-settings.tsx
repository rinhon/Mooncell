import { useEffect, useState, type FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Save, TestTube2 } from "lucide-react"
import { api, type Downloader } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { ActionButton } from "@/components/ui/action-button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field } from "@/components/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useToast } from "@/components/ui/toast"

type Form = { name: string; kind: "qbittorrent" | "aria2"; base_url: string; username: string; secret: string }
type TestResult = { ok: boolean; message: string; version?: string }

function testFingerprint(form: Form) {
  return JSON.stringify(form)
}

/** 设置页中的单一下载器配置卡；保存时自动创建或更新。 */
export function DownloaderSettingsSection() {
  const client = useQueryClient()
  const toast = useToast()
  const [form, setForm] = useState<Form>({ name: "qBittorrent", kind: "qbittorrent", base_url: "http://192.168.1.10:8080", username: "", secret: "" })
  const [lastTest, setLastTest] = useState<{ fingerprint: string; result: TestResult } | null>(null)
  const list = useQuery({ queryKey: ["downloaders"], queryFn: () => api<Downloader[]>("/downloaders") })
  const saved = list.data?.[0]

  useEffect(() => {
    if (!saved) return
    setForm({
      name: saved.name,
      kind: saved.kind,
      base_url: saved.base_url,
      username: saved.username ?? "",
      secret: "",
    })
  }, [saved?.id, saved?.name, saved?.kind, saved?.base_url, saved?.username])

  const payload = { ...form, verify_tls: false, active: true, organize_strategy: "downloader_managed" }
  const test = useMutation({
    mutationFn: () => {
      // 未修改的已保存配置走持久化测试接口；编辑中的配置先测试当前表单值。
      const unchanged = saved && !form.secret && form.name === saved.name && form.kind === saved.kind
        && form.base_url.replace(/\/$/, "") === saved.base_url && form.username === (saved.username ?? "")
      return unchanged
        ? api<TestResult>(`/downloaders/${saved.id}/test`, { method: "POST" })
        : api<TestResult>("/downloaders/test", { method: "POST", body: JSON.stringify(payload) })
    },
    onSuccess: (result) => {
      setLastTest({ fingerprint: testFingerprint(form), result })
      void client.invalidateQueries({ queryKey: ["downloaders"] })
      toast(result.ok ? "下载器连接正常" : "下载器连接失败", { description: `${result.message}${result.version ? ` · ${result.version}` : ""}`, tone: result.ok ? "success" : "error" })
    },
    onError: (error) => toast("连接测试失败", { description: error.message, tone: "error" }),
  })
  const save = useMutation({
    mutationFn: async () => {
      const downloader = await api<Downloader>(saved ? `/downloaders/${saved.id}` : "/downloaders", { method: saved ? "PATCH" : "POST", body: JSON.stringify(payload) })
      // 当前表单刚刚测试过时，保存后再用持久化接口复核并写入数据库状态。
      const testedCurrentForm = lastTest?.fingerprint === testFingerprint(form)
      const persistedTest = testedCurrentForm
        ? await api<TestResult>(`/downloaders/${downloader.id}/test`, { method: "POST" })
        : null
      return { downloader, persistedTest }
    },
    onSuccess: ({ persistedTest }) => {
      setForm((state) => ({ ...state, secret: "" }))
      if (persistedTest) setLastTest({ fingerprint: testFingerprint({ ...form, secret: "" }), result: persistedTest })
      void client.invalidateQueries({ queryKey: ["downloaders"] })
      void client.invalidateQueries({ queryKey: ["dashboard"] })
      toast(saved ? "下载器配置已更新" : "下载器配置已保存", { description: persistedTest ? "连接测试结果已保存。" : undefined })
    },
    onError: (error) => toast("配置保存失败", { description: error.message, tone: "error" }),
  })

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setLastTest(null)
    setForm((state) => ({ ...state, [key]: value }))
  }
  function submit(event: FormEvent) { event.preventDefault(); save.mutate() }
  const status = lastTest ? (lastTest.result.ok ? "healthy" : "error") : saved?.connection_status ?? "unknown"
  const testedVersion = lastTest?.result.version

  return <section id="downloader" className="grid gap-4">
    <Card>
      <CardHeader><div><CardTitle>下载器连接</CardTitle><CardDescription>{saved ? "修改后直接保存；密码留空会保留当前密码。" : "填写连接信息后可先测试，再保存配置。"}</CardDescription></div><Badge tone={status === "healthy" ? "success" : status === "error" ? "danger" : "neutral"}>{status === "healthy" ? `已连接${testedVersion ? ` · ${testedVersion}` : ""}` : status === "error" ? "异常" : saved ? "未测试" : "未配置"}</Badge></CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-4 md:grid-cols-2">
          <Field label="名称"><Input value={form.name} onChange={(event) => set("name", event.target.value)} required/></Field>
          <Field label="类型"><Select value={form.kind} onValueChange={(value) => set("kind", value as Form["kind"])}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent><SelectItem value="qbittorrent">qBittorrent</SelectItem><SelectItem value="aria2">aria2</SelectItem></SelectContent></Select></Field>
          <div className="md:col-span-2"><Field label="Web API 地址"><Input value={form.base_url} onChange={(event) => set("base_url", event.target.value)} required/></Field></div>
          <Field label="用户名"><Input value={form.username} onChange={(event) => set("username", event.target.value)} disabled={form.kind === "aria2"}/></Field>
          <Field label="密码 / RPC Secret" hintPosition="top" hint={saved ? "留空表示不修改" : undefined}><Input type="password" value={form.secret} onChange={(event) => set("secret", event.target.value)}/></Field>
          {saved?.last_error && <p className="rounded-[2px] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)] md:col-span-2">{saved.last_error}</p>}
          {save.error && <p className="rounded-[2px] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)] md:col-span-2">{save.error.message}</p>}
          <div className="flex flex-col-reverse gap-2 md:col-span-2 sm:flex-row sm:justify-end"><ActionButton icon={TestTube2} emphasis="secondary" onClick={() => test.mutate()} pending={test.isPending} pendingLabel="测试中…" disabled={save.isPending}>测试连接</ActionButton><ActionButton type="submit" icon={Save} pending={save.isPending} pendingLabel="保存中…" disabled={test.isPending}>保存配置</ActionButton></div>
        </form>
      </CardContent>
    </Card>
  </section>
}
