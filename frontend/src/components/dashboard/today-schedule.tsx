import { Link } from "react-router-dom"
import { Heart, ImageOff } from "lucide-react"
import { FadeInImage } from "@/components/ui/fade-in-image"
import { ModuleError, ModuleSkeleton } from "./module-state"
import type { ModuleQuery, SeasonCalendar } from "./types"

export function TodaySchedule({ query, now }: { query: ModuleQuery<SeasonCalendar>; now: Date }) {
  const today = (now.getDay() + 6) % 7
  const href = `/calendar?day=${today}`
  const items = (query.data?.items ?? [])
    .filter((item) => item.weekday === today)
    .sort((a, b) => Number(b.liked) - Number(a.liked) || a.broadcast_time.localeCompare(b.broadcast_time))
  const date = now.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" })
  return (
    <section className="dashboard-panel" aria-labelledby="dashboard-today-title">
      <header className="dashboard-panel-heading">
        <div>
          <h2 id="dashboard-today-title">今日放送</h2>
          <p className="text-caption text-muted">{date}</p>
        </div>
        <Link to={href}>查看日历</Link>
      </header>
      {query.isError && (
        <ModuleError message={`放送日历读取失败：${query.error?.message ?? "请稍后重试"}`} onRetry={query.refetch} />
      )}
      {!query.data && query.isPending && <ModuleSkeleton label="正在加载今日放送" rows={4} />}
      {query.data &&
        (items.length ? (
          <>
            <ul className="dashboard-schedule-list">
              {items.slice(0, 4).map((item) => (
                <li key={item.id}>
                  <Link
                    to={href}
                    className="dashboard-schedule-item"
                    aria-label={`${item.title}，${item.broadcast_time || "时间待定"}${item.liked ? "，已喜欢" : ""}，查看放送日历`}
                  >
                    <span className="dashboard-schedule-cover">
                      {item.cover_url ? (
                        <FadeInImage
                          src={item.cover_url}
                          alt=""
                          loading="lazy"
                          fallback={<ImageOff size={16} aria-hidden="true" />}
                        />
                      ) : (
                        <ImageOff size={16} aria-hidden="true" />
                      )}
                    </span>
                    <span className="dashboard-schedule-copy">
                      <strong>{item.title}</strong>
                      <span>{item.broadcast_time || "时间待定"}</span>
                    </span>
                    {item.liked && (
                      <Heart className="dashboard-liked" size={15} fill="currentColor" aria-label="已喜欢" />
                    )}
                  </Link>
                </li>
              ))}
            </ul>
            <p className="dashboard-panel-footnote">
              共 {items.length} 部{items.some((item) => item.liked) ? " · 已喜欢的番剧优先显示" : " · 按放送时间排列"}
            </p>
          </>
        ) : (
          <div className="dashboard-module-empty">
            <p>今天暂无放送安排</p>
            <Link to={href}>查看本周日历</Link>
          </div>
        ))}
    </section>
  )
}
