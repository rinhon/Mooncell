import { useState, type FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowUpRight, Save } from "lucide-react"
import { api } from "@/lib/api"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Field } from "@/components/field"
import { Input } from "@/components/ui/input"
import { ActionButton } from "@/components/ui/action-button"
import { useToast } from "@/components/ui/toast"

type Options = { read_access_token_configured: boolean; api_key_configured: boolean }

export function TmdbSettingsSection() {
  const client = useQueryClient()
  const toast = useToast()
  const query = useQuery({ queryKey: ["tmdb-settings"], queryFn: () => api<Options>("/settings/tmdb") })
  const [token, setToken] = useState("")
  const [key, setKey] = useState("")
  const [clearToken, setClearToken] = useState(false)
  const [clearKey, setClearKey] = useState(false)
  const save = useMutation({
    mutationFn: () => api<Options>("/settings/tmdb", { method: "PATCH", body: JSON.stringify({
      read_access_token: clearToken ? "" : token.trim() || undefined,
      api_key: clearKey ? "" : key.trim() || undefined,
    }) }),
    onSuccess: (data) => {
      client.setQueryData(["tmdb-settings"], data)
      setToken(""); setKey(""); setClearToken(false); setClearKey(false)
      toast("TMDB 设置已保存", { description: "后续搜索与刮削将使用新配置。" })
    },
    onError: (error) => toast("TMDB 设置保存失败", { description: error.message, tone: "error" }),
  })
  function submit(event: FormEvent) { event.preventDefault(); save.mutate() }
  return <Card id="tmdb"><CardHeader><div><CardTitle>TMDB 元数据与图片</CardTitle><CardDescription>通过官方 API 搜索作品、获取元数据及图片。两项任选其一；同时配置时优先使用读访问令牌。</CardDescription></div></CardHeader><CardContent>
    {query.isPending ? <p role="status">正在读取 TMDB 设置…</p> : query.isError ? <p role="alert" className="text-sm text-[var(--danger)]">读取失败：{query.error.message}<button className="ml-3 underline" onClick={() => void query.refetch()}>重试</button></p> : <form onSubmit={submit} className="grid gap-4">
      <Field label="TMDB API 读访问令牌" hint="输入令牌本身，无需添加 Bearer 前缀。留空保留原配置。"><Input type="password" autoComplete="new-password" maxLength={4096} value={token} disabled={save.isPending || clearToken} onChange={(event) => setToken(event.target.value)} placeholder={query.data.read_access_token_configured ? "已配置（加密保存）" : "未配置"}/></Field>
      {query.data.read_access_token_configured && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={clearToken} disabled={save.isPending} onChange={(event) => setClearToken(event.target.checked)}/>保存时清除读访问令牌</label>}
      <Field label="TMDB API 密钥" hint="API Key（v3 auth）。未配置读访问令牌时使用；留空保留原配置。"><Input type="password" autoComplete="new-password" maxLength={256} value={key} disabled={save.isPending || clearKey} onChange={(event) => setKey(event.target.value)} placeholder={query.data.api_key_configured ? "已配置（加密保存）" : "未配置"}/></Field>
      {query.data.api_key_configured && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={clearKey} disabled={save.isPending} onChange={(event) => setClearKey(event.target.checked)}/>保存时清除 API 密钥</label>}
      <p className="text-xs text-[var(--muted)]">在 <a className="inline-flex items-center gap-0.5 text-[var(--accent)] underline underline-offset-2 hover:text-[var(--accent-hover)]" href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener noreferrer">TMDB 账户的 API 设置<ArrowUpRight size={13} aria-hidden="true"/></a> 中获取凭据。保存后立即生效；已有番剧可通过“重新刮削”更新。</p>
      <div className="flex justify-end"><ActionButton type="submit" icon={Save} pending={save.isPending} pendingLabel="保存中…">保存 TMDB 设置</ActionButton></div>
    </form>}
  </CardContent></Card>
}
