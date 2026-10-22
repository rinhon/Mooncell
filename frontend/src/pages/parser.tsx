import { useState, type FormEvent } from "react"
import { useMutation } from "@tanstack/react-query"
import { Braces, CheckCircle2, Sparkles, TriangleAlert } from "lucide-react"
import { api, type ParsedRelease } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { ActionButton } from "@/components/ui/action-button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"

const sample = "[ANi] Sousou no Frieren - 05 [1080P][Baha][WEB-DL][AAC AVC][CHT]"
/** 用真实发布标题验证解析器，并展示置信度和可解释依据。 */
export function ParserSettingsSection() {
  const [title, setTitle] = useState(sample)
  const parse = useMutation({
    mutationFn: () => api<ParsedRelease>("/parser/preview", { method: "POST", body: JSON.stringify({ title }) }),
  })
  function submit(e: FormEvent) {
    e.preventDefault()
    parse.mutate()
  }
  return (
    <>
      <Card>
        <CardHeader>
          <div>
            <CardTitle>标题解析</CardTitle>
            <CardDescription>粘贴发布标题，验证番剧名、集数、字幕组和清晰度。</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-3 sm:flex-row" onSubmit={submit}>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} className="flex-1" />
            <ActionButton type="submit" icon={Sparkles} pending={parse.isPending} pendingLabel="解析中…">
              开始解析
            </ActionButton>
          </form>
        </CardContent>
      </Card>
      {parse.data && (
        <section className="mt-5 grid gap-5 lg:grid-cols-[1.1fr_.9fr]">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>结构化结果</CardTitle>
                <CardDescription>置信度达到 0.80 才会进入自动流程。</CardDescription>
              </div>
              <Badge tone={parse.data.confidence >= 0.8 ? "success" : "warning"}>
                {Math.round(parse.data.confidence * 100)}%
              </Badge>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {[
                  ["番剧", parse.data.title],
                  ["字幕组", parse.data.release_group],
                  ["类型", parse.data.media_type],
                  ["季度", parse.data.season ?? "自动"],
                  ["集数", parse.data.episode_start],
                  ["清晰度", parse.data.resolution],
                ].map(([k, v]) => (
                  <div className="rounded-inset border border-border-soft bg-surface/20 p-3" key={String(k)}>
                    <p className="text-xs text-muted">{k}</p>
                    <p className="mt-1 truncate text-sm font-medium">{v ?? "未识别"}</p>
                  </div>
                ))}
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {[
                  ...parse.data.sources,
                  ...parse.data.subtitle_languages,
                  ...parse.data.video_codecs,
                  ...parse.data.audio_codecs,
                ].map((v) => (
                  <Badge key={v}>{v}</Badge>
                ))}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <div>
                <CardTitle>判断依据</CardTitle>
                <CardDescription>让自动化决策保持可解释。</CardDescription>
              </div>
              <Braces size={18} className="text-muted" />
            </CardHeader>
            <CardContent className="grid gap-2">
              {parse.data.evidence.map((v) => (
                <p key={v} className="flex gap-2 text-sm text-muted">
                  <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-accent" />
                  {v}
                </p>
              ))}
              {parse.data.warnings.map((v) => (
                <p key={v} className="flex gap-2 text-sm text-warning">
                  <TriangleAlert size={16} className="mt-0.5 shrink-0" />
                  {v}
                </p>
              ))}
            </CardContent>
          </Card>
        </section>
      )}
    </>
  )
}
