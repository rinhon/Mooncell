import { FlaskConical } from "lucide-react"
import { DEMO_MODE } from "@/hooks/use-demo-data"

/** 明确区分演示数据与真实后端数据，避免用户误认为已经产生下载任务。 */
export function DemoIndicator() {
  if (!DEMO_MODE) return null
  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 rounded-inset bg-surface/20 px-2.5 py-1 text-xs font-semibold",
        "text-warning ring-1 ring-[color-mix(in_oklab,var(--warning)_30%,transparent)]",
      ].join(" ")}
    >
      <FlaskConical size={12} />
      开发演示数据
    </span>
  )
}
