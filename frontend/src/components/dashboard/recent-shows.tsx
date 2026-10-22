import { Link } from "react-router-dom"
import { motion, useReducedMotion } from "motion/react"
import type { Show } from "@/lib/api"
import { posterUrl } from "@/lib/show-artwork"
import { spring } from "@/lib/motion"
import { ShowCover } from "@/components/show-cover"
import { FadeInImage } from "@/components/ui/fade-in-image"
import { ModuleError, ModuleSkeleton } from "./module-state"
import type { ModuleQuery } from "./types"

export function RecentShows({ query }: { query: ModuleQuery<Show[]> }) {
  const reducedMotion = useReducedMotion()
  const shows = [...(query.data ?? [])]
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)
    .slice(0, 5)
  return (
    <section className="dashboard-recent-shows" aria-labelledby="dashboard-shows-title">
      <header className="dashboard-panel-heading">
        <div>
          <h2 id="dashboard-shows-title">最近添加</h2>
          <p>你的番剧收藏</p>
        </div>
        <Link to="/shows">查看全部</Link>
      </header>
      {query.isError && (
        <ModuleError message={`番剧读取失败：${query.error?.message ?? "请稍后重试"}`} onRetry={query.refetch} />
      )}
      {!query.data && query.isPending && <ModuleSkeleton label="正在加载最近添加的番剧" rows={2} />}
      {query.data &&
        (shows.length ? (
          <div className="dashboard-poster-grid">
            {shows.map((show) => (
              <motion.div
                key={show.id}
                whileHover={reducedMotion ? undefined : { y: -3 }}
                transition={spring.snappy}
                className="min-w-0"
              >
                <Link className="dashboard-poster-link" to={`/shows/${show.id}`} aria-label={`查看番剧：${show.name}`}>
                  <span className="dashboard-poster-image">
                    {posterUrl(show) ? (
                      <FadeInImage
                        src={posterUrl(show)!}
                        alt=""
                        loading="lazy"
                        fallback={<ShowCover title={show.name} />}
                      />
                    ) : (
                      <ShowCover title={show.name} />
                    )}
                  </span>
                  <strong title={show.name}>{show.name}</strong>
                  <span>已发现 {show.discovered_items} 条发布</span>
                </Link>
              </motion.div>
            ))}
          </div>
        ) : (
          <p className="dashboard-module-empty">添加订阅后，最近添加的番剧会显示在这里。</p>
        ))}
    </section>
  )
}
