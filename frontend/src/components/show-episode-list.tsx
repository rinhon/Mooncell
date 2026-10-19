import { useEffect, useRef, useState } from "react"
import { FileVideo2 } from "lucide-react"
import type { Show, ShowEpisode } from "@/lib/api"
import { artworkUrl, posterUrl } from "@/lib/show-artwork"
import { BlurFade } from "@/components/ui/blur-fade"
import { Button } from "@/components/ui/button"

const BATCH_SIZE = 12

function fileSize(size: number) {
  if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(2)} GB`
  if (size >= 1024 ** 2) return `${(size / 1024 ** 2).toFixed(1)} MB`
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${size} B`
}

function EpisodeThumbnail({ show, item }: { show: Show; item: ShowEpisode }) {
  const fallback = show.fanart_ready ? artworkUrl(show, "fanart") : posterUrl(show)
  const [failed, setFailed] = useState<string[]>([])
  const src = [item.thumbnail_url, fallback].find(url => url && !failed.includes(url))
  return <span className="release-thumbnail">{src ? <img src={src} alt="" loading="lazy" onError={() => setFailed(previous => [...previous, src])}/> : <FileVideo2 size={25} aria-hidden="true"/>}</span>
}

export function ShowEpisodeList({ show, items }: { show: Show; items: ShowEpisode[] }) {
  const [visibleCount, setVisibleCount] = useState(BATCH_SIZE)
  const sentinel = useRef<HTMLDivElement>(null)
  const hasMore = visibleCount < items.length
  useEffect(() => {
    const element = sentinel.current
    if (!element || !hasMore || !("IntersectionObserver" in window)) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        observer.disconnect()
        setVisibleCount(count => count + BATCH_SIZE)
      }
    }, { rootMargin: "0px 0px 300px 0px" })
    observer.observe(element)
    return () => observer.disconnect()
  }, [visibleCount, hasMore, items.length])

  return <>
    <ul className="release-list episode-list" aria-label="本地视频文件">
      {items.slice(0, visibleCount).map((item, index) => <li key={item.path}>
        <BlurFade className="release-row" delay={Math.min(index % BATCH_SIZE, 6) * .06} duration={.4} offset={8} inView inViewMargin="0px">
          <EpisodeThumbnail show={show} item={item}/>
          <div className="release-copy">
            <h3>{show.media_type === "movie" || item.episode_start == null ? item.filename : `第 ${item.episode_start}${item.episode_end != null && item.episode_end !== item.episode_start ? `–${item.episode_end}` : ""} 集`}</h3>
            {show.media_type !== "movie" && item.episode_start != null && <p className="episode-filename">{item.filename}</p>}
            <p className="release-fields"><span>{fileSize(item.size)}</span><span>{item.filename.split(".").pop()?.toUpperCase()}</span></p>
          </div>
          <span className="release-status episode-file-status">本地文件</span>
        </BlurFade>
      </li>)}
    </ul>
    <div ref={sentinel} className="episode-load-status" aria-live="polite">
      {hasMore ? <Button variant="ghost" size="sm" onClick={() => setVisibleCount(count => count + BATCH_SIZE)}>加载更多</Button> : items.length > 0 && <span>共 {items.length} 个视频文件</span>}
    </div>
  </>
}
