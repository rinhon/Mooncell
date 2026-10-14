import { useState, type FormEvent } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { ArrowRight, MoonStar } from "lucide-react"
import { Button } from "@/components/ui/button"
import { api, type AuthStatus } from "@/lib/api"
import { Input } from "@/components/ui/input"
import { Field } from "@/components/field"

/** 首次访问用于创建唯一管理员，之后自动切换成普通登录表单。 */
export function AuthScreen({ initialized }: { initialized: boolean }) {
  const client = useQueryClient()
  const [username, setUsername] = useState("admin")
  const [password, setPassword] = useState("")
  const mutation = useMutation({
    mutationFn: () => api<AuthStatus>(initialized ? "/auth/login" : "/auth/bootstrap", { method: "POST", body: JSON.stringify({ username, password }) }),
    onSuccess: (data) => client.setQueryData(["auth"], data),
  })
  function submit(event: FormEvent) { event.preventDefault(); mutation.mutate() }

  return <main className="auth-screen">
    <div className="auth-panel">
      <section className="auth-intro">
        <div className="auth-brand"><MoonStar size={23} strokeWidth={1.3}/><span>MOONCELL</span></div>
        <div className="auth-intro-copy"><p className="micro-label">YOUR PERSONAL ANIME LIBRARY</p><h1>追番，<br/>从容一点。</h1><p>发现新番，收进你的媒体库。</p></div>
        <span className="auth-intro-footer">每一份期待，都有归处。</span>
      </section>
      <section className="auth-form-panel">
        <form className="w-full" onSubmit={submit}>
          <div className="mb-8 text-[var(--ink)] md:hidden"><MoonStar /></div>
          <p className="text-sm font-medium text-[var(--muted)]">{initialized ? "欢迎回来" : "首次使用"}</p>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight">{initialized ? "登录 Mooncell" : "创建管理员账户"}</h2>
          <p className="mt-3 text-sm leading-6 text-[var(--muted)]">{initialized ? "继续管理你的番剧与订阅。" : "这是局域网内唯一的管理账户，密码至少 10 位。"}</p>
          <div className="mt-8 grid gap-5">
            <Field label="用户名"><Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required /></Field>
            <Field label="密码"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={initialized ? "current-password" : "new-password"} minLength={10} required /></Field>
            {mutation.error && <p className="rounded-[2px] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">{mutation.error.message}</p>}
            <Button type="submit" size="lg" className="mt-2 w-full" icon={ArrowRight} pending={mutation.isPending} pendingLabel={initialized ? "登录中…" : "创建中…"}>{initialized ? "登录" : "创建账户并继续"}</Button>
          </div>
        </form>
      </section>
    </div>
  </main>
}
