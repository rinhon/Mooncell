import { useEffect, useState } from "react"
import type { DemoDownload, DemoOrganizeTask, DemoReview, DemoShow } from "@/mocks/demo-data"

type DemoData = {
  enabled: boolean
  shows: DemoShow[]
  downloads: DemoDownload[]
  organizeTasks: DemoOrganizeTask[]
  reviews: DemoReview[]
  logs: Array<{ time: string; level: string; scope: string; message: string }>
  calendar: Array<{
    day: string
    date: string
    items: Array<{ title: string; episode: number; time: string; accent: string }>
  }>
}

const EMPTY_DATA: DemoData = {
  enabled: false,
  shows: [],
  downloads: [],
  organizeTasks: [],
  reviews: [],
  logs: [],
  calendar: [],
}
export const DEMO_MODE = import.meta.env.DEV && import.meta.env.VITE_DEMO_DATA !== "false"

/**
 * 仅在 Vite 开发模式动态加载演示数据。
 * 生产构建会把恒为 false 的分支和整个 mock chunk 一起裁剪掉。
 */
export function useDemoData() {
  const [data, setData] = useState<DemoData>(EMPTY_DATA)
  useEffect(() => {
    if (!DEMO_MODE) return
    void import("@/mocks/demo-data").then((module) =>
      setData({
        enabled: true,
        shows: module.demoShows,
        downloads: module.demoDownloads,
        organizeTasks: module.demoOrganizeTasks,
        reviews: module.demoReviews,
        logs: module.demoLogs,
        calendar: module.demoCalendar,
      }),
    )
  }, [])
  return data
}
