import { lazy, Suspense, useState, type FormEvent } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { ArrowRight, MoonStar } from "lucide-react"
import { Button } from "@/components/ui/button"
import { api, type AuthStatus } from "@/lib/api"
import { Input } from "@/components/ui/input"
import { Field } from "@/components/field"
import { loginPosterItems } from "@/lib/login-posters"
import { MagicCard } from "@/components/ui/magic-card"
import { useTheme } from "@/lib/theme"

const GridMotion = lazy(() => import("@/components/grid-motion"))

/** 首次访问用于创建唯一管理员，之后自动切换成普通登录表单。 */
export function AuthScreen({ initialized }: { initialized: boolean }) {
  const { theme, palette } = useTheme()
  const client = useQueryClient()
  const [username, setUsername] = useState("admin")
  const [password, setPassword] = useState("")
  const mutation = useMutation({
    mutationFn: () =>
      api<AuthStatus>(initialized ? "/auth/login" : "/auth/bootstrap", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      }),
    onSuccess: (data) => client.setQueryData(["auth"], data),
  })
  function submit(event: FormEvent) {
    event.preventDefault()
    mutation.mutate()
  }

  return (
    <main className="auth-screen">
      <div className="auth-background" aria-hidden="true">
        <Suspense fallback={null}>
          <GridMotion
            items={loginPosterItems}
            rows={6}
            aspectRatio={2 / 3}
            gap={12}
            radius={4}
            speed={12}
            parallax={0}
            spotlight={0}
            dim={0.15}
            fade={0.2}
          />
        </Suspense>
        <div className="auth-background-scrim" />
      </div>
      <MagicCard
        className="auth-panel"
        gradientSize={260}
        gradientColor={theme === "ocean" ? palette.accent : "var(--auth-glow)"}
        gradientOpacity={theme === "ocean" ? 0.15 : 0.4}
        gradientFrom={palette.accent}
        gradientTo={palette.secondary}
      >
        <section className="auth-form-panel">
          <form className="w-full" onSubmit={submit}>
            <div className="auth-brand mb-9">
              <MoonStar size={23} strokeWidth={1.3} />
              <span>MOONCELL</span>
            </div>
            <p className="text-sm font-medium text-muted">{initialized ? "欢迎回来" : "首次使用"}</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">
              {initialized ? "登录 Mooncell" : "创建管理员账户"}
            </h1>
            <p className="mt-3 text-sm leading-6 text-muted">
              {initialized ? "继续管理你的番剧与订阅。" : "这是局域网内唯一的管理账户，密码至少 10 位。"}
            </p>
            <div className="mt-8 grid gap-5">
              <Field label="用户名">
                <Input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  required
                />
              </Field>
              <Field label="密码">
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={initialized ? "current-password" : "new-password"}
                  minLength={10}
                  required
                />
              </Field>
              {mutation.error && (
                <p className="rounded-control bg-danger-soft px-3 py-2 text-sm text-danger">{mutation.error.message}</p>
              )}
              <Button
                type="submit"
                size="lg"
                className="mt-2 w-full"
                icon={ArrowRight}
                pending={mutation.isPending}
                pendingLabel={initialized ? "登录中…" : "创建中…"}
              >
                {initialized ? "登录" : "创建账户并继续"}
              </Button>
            </div>
          </form>
        </section>
      </MagicCard>
    </main>
  )
}
