import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Download, Radio, Search, TerminalSquare } from "lucide-react"
import { api, type LogEntry } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { ActionButton } from "@/components/ui/action-button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { PageHeading } from "@/components/page-heading"

type ConnectionState = "connecting" | "connected" | "reconnecting"

/** 持久化历史事件与 SSE 增量事件合并后的实时日志页面。 */
export function LogsPage() {
  const [query, setQuery] = useState("")
  const [level, setLevel] = useState("all")
  const [liveLogs, setLiveLogs] = useState<LogEntry[]>([])
  const [connection, setConnection] = useState<ConnectionState>("connecting")
  const logViewport = useRef<HTMLDivElement>(null)
  const followLatest = useRef(true)
  const previousFilter = useRef({ query, level })
  const history = useQuery({
    queryKey: ["logs"],
    queryFn: () => api<LogEntry[]>("/logs?limit=200"),
  })

  useEffect(() => {
    const stream = new EventSource("/api/v1/events/stream", { withCredentials: true })
    stream.onopen = () => setConnection("connected")
    stream.onerror = () => setConnection("reconnecting")
    const receive = (event: MessageEvent<string>) => {
      const data = JSON.parse(event.data) as {
        id: number
        occurredAt: string
        level: LogEntry["level"]
        scope: string
        type: string
        message: string
      }
      const next: LogEntry = {
        id: data.id,
        occurred_at: data.occurredAt,
        level: data.level,
        scope: data.scope,
        event_type: data.type,
        message: data.message,
      }
      setLiveLogs((current) =>
        [next, ...current.filter((item) => item.id !== next.id)].slice(0, 500),
      )
    }
    stream.addEventListener("log", receive as EventListener)
    return () => stream.close()
  }, [])

  const logs = useMemo(() => {
    const byId = new Map<number, LogEntry>()
    for (const item of history.data ?? []) byId.set(item.id, item)
    for (const item of liveLogs) byId.set(item.id, item)
    return [...byId.values()]
      .sort((left, right) => left.id - right.id)
      .filter((item) => level === "all" || item.level === level)
      .filter((item) =>
        `${item.level} ${item.scope} ${item.event_type} ${item.message}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
      )
  }, [history.data, liveLogs, query, level])

  useLayoutEffect(() => {
    if (previousFilter.current.query !== query || previousFilter.current.level !== level) {
      followLatest.current = true
      previousFilter.current = { query, level }
    }
    const viewport = logViewport.current
    if (viewport && followLatest.current) viewport.scrollTop = viewport.scrollHeight
  }, [logs, query, level, history.isLoading])

  function downloadLogs() {
    const content = logs
      .map(
        (item) =>
          `${item.occurred_at}\t${item.level.toUpperCase()}\t${item.scope}\t${item.event_type}\t${item.message}`,
      )
      .join("\n")
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }))
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `mooncell-${new Date().toISOString().slice(0, 10)}.log`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const status =
    connection === "connected" ? "已连接" : connection === "reconnecting" ? "正在重连" : "连接中"

  return <>
    <PageHeading
      eyebrow="Observability"
      title="实时日志"
      description="筛选 RSS、日历抓取、解析器、下载器和整理器日志；敏感凭据在进入浏览器前脱敏。"
      action={<ActionButton icon={Download} pendingLabel="导出中…" emphasis="secondary" onClick={downloadLogs} disabled={!logs.length}>下载日志</ActionButton>}
    />
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">事件流 <span className={`inline-flex items-center gap-1.5 text-xs font-normal ${connection === "connected" ? "text-[var(--accent)]" : "text-[var(--warning)]"}`}><Radio size={12} className={connection === "connected" ? "animate-pulse" : ""}/>{status}</span></CardTitle>
          <CardDescription>SSE 实时接续 · 保留最近 500 条 · 当前显示 {logs.length} 条</CardDescription>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
          <Select value={level} onValueChange={setLevel}>
            <SelectTrigger aria-label="日志类型" className="sm:w-40"><SelectValue/></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部类型</SelectItem>
              <SelectItem value="info">信息（info）</SelectItem>
              <SelectItem value="warning">警告（warning）</SelectItem>
              <SelectItem value="error">错误（error）</SelectItem>
            </SelectContent>
          </Select>
          <div className="relative w-full sm:w-72">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" size={15}/>
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索级别、范围或消息" className="pl-9"/>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div ref={logViewport} onScroll={(event) => {
          const viewport = event.currentTarget
          followLatest.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 24
        }} className="max-h-[65vh] overflow-y-auto rounded-[2px] bg-[var(--surface)]/20 ring-1 ring-[var(--border)] font-mono text-xs">
          {logs.map((item) => <div key={item.id} className="grid gap-2 border-b border-[var(--border)] px-4 py-3 sm:grid-cols-[76px_72px_110px_1fr]">
            <span className="text-[var(--muted)]">{new Date(item.occurred_at).toLocaleTimeString("zh-CN", { hour12: false })}</span>
            <Badge className="log-level-badge h-6 w-[72px] shrink-0 self-start justify-center whitespace-nowrap px-0 py-0" tone={item.level === "error" ? "danger" : item.level === "warning" ? "warning" : "neutral"}>{item.level}</Badge>
            <span className="text-[var(--ink-2)]">{item.scope}</span>
            <span className="leading-5 text-[var(--ink)]"><span className="mr-2 text-[var(--muted)]">{item.event_type}</span>{item.message}</span>
          </div>)}
          {history.isLoading && <div className="grid min-h-48 place-items-center text-[13px] text-[var(--muted)]">正在读取日志…</div>}
          {!history.isLoading && !logs.length && <div className="grid min-h-48 place-items-center gap-2 text-[13px] text-[var(--muted)]"><TerminalSquare/><span>{level !== "all" || query.trim() ? "没有匹配的日志，请调整类型或搜索关键词。" : "暂无真实事件，刷新一次 RSS 后会实时显示。"}</span></div>}
        </div>
      </CardContent>
    </Card>
  </>
}
