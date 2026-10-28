import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import type { Show } from "@/lib/api"
import { posterUrl } from "@/lib/show-artwork"
import { ShowCover } from "@/components/show-cover"
import { FadeInImage } from "@/components/ui/fade-in-image"
import { Masonry } from "@/components/ui/masonry"
import { ModuleError, ModuleSkeleton } from "./module-state"
import type { ModuleQuery } from "./types"

export function RecentShows({ query }: { query: ModuleQuery<Show[]> }) {
  const [desktop, setDesktop] = useState(() => window.matchMedia("(min-width: 1024px)").matches)
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)")
    const update = () => setDesktop(media.matches)
    update()
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])
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
          <Masonry className="dashboard-poster-grid" columns={desktop ? 5 : "auto"} extraHeight={52}>
            {shows.map((show) => (
              <Link
                key={show.id}
                className="dashboard-poster-link"
                to={`/shows/${show.id}`}
                aria-label={`查看番剧：${show.name}`}
              >
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
            ))}
          </Masonry>
        ) : (
          <p className="dashboard-module-empty">添加订阅后，最近添加的番剧会显示在这里。</p>
        ))}
    </section>
  )
}
