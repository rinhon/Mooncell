import { FlaskConical } from "lucide-react"
import { DEMO_MODE } from "@/hooks/use-demo-data"

/** 明确区分演示数据与真实后端数据，避免用户误认为已经产生下载任务。 */
export function DemoIndicator() {
  if (!DEMO_MODE) return null
  return <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--surface)]/20 px-2.5 py-1 text-[13px] font-semibold text-[var(--warning)] ring-1 ring-amber-800/15"><FlaskConical size={12}/>开发演示数据</span>
}
