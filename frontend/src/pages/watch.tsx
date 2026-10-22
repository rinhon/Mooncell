import { useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link, useLocation, useNavigate, useParams } from "react-router-dom"
import { ArrowLeft, LoaderCircle, TriangleAlert } from "lucide-react"
import { api, type ShowDetail, type ShowLibrary } from "@/lib/api"
import type { PlaybackInfo } from "@/lib/player/types"
import { artworkUrl, posterUrl } from "@/lib/show-artwork"
import { Player } from "@/components/player/player"
import { episodeLabel } from "@/components/player/player-episodes"
import "@/components/player/player.css"

export function WatchPage() {
  const { mediaId = "" } = useParams()
  const { key: navigationKey, state } = useLocation()
  const navigate = useNavigate()
  // Keep the fullscreen element mounted while a different episode is probed.
  const fullscreenTarget = useRef<HTMLElement>(null)
  const [preferences, setPreferences] = useState({ volume: .8, rate: 1 })
  const info = useQuery({
    queryKey: ["playback-info", mediaId, navigationKey],
    queryFn: ({ signal }) => api<PlaybackInfo>(`/media/${mediaId}/playback-info`, { signal }),
    gcTime: 0,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  })
  const sourceId = info.data?.source_id
  const show = useQuery({ queryKey: ["show", sourceId], queryFn: () => api<ShowDetail>(`/shows/${sourceId}`), enabled: sourceId != null })
  const library = useQuery({ queryKey: ["show-library", sourceId], queryFn: () => api<ShowLibrary>(`/shows/${sourceId}/library`), enabled: sourceId != null })
  const title = show.data?.metadata_title ?? show.data?.name ?? "在线播放"
  const currentEpisode = library.data?.seasons.flatMap(season => season.items).find(item => item.media_id === mediaId)
  const subtitle = currentEpisode ? `${currentEpisode.season && currentEpisode.season > 0 ? `第 ${currentEpisode.season} 季 · ` : ""}${episodeLabel(currentEpisode)}` : info.data?.filename ?? "正在读取视频信息…"
  const backTo = sourceId != null ? `/shows/${sourceId}` : "/shows"
  const artwork = show.data ? (show.data.fanart_ready ? artworkUrl(show.data, "fanart") : posterUrl(show.data)) : undefined
  const pending = info.isPending || !info.isFetchedAfterMount

  return <main ref={fullscreenTarget} className="watch-page" aria-label="视频播放">
    {pending || info.error || !info.data?.supported ? <>
      <header className="player-header"><Link className="player-icon-button player-back" to={backTo} aria-label="返回番剧" title="返回番剧"><ArrowLeft size={23}/></Link><div className="player-heading"><h1>{title}</h1><p>{subtitle}</p></div></header>
      <div className="watch-state" role={pending ? "status" : "alert"}>
        {pending ? <><LoaderCircle className="player-spinner" size={30}/><p>正在读取视频…</p></> : <><TriangleAlert size={30}/><h2>暂时无法播放</h2><p>{info.error?.message ?? info.data?.unsupported_reason ?? "此视频暂不支持在线播放"}</p>{info.error && <button className="player-action-button" onClick={() => void info.refetch()}>重新读取</button>}<Link to={backTo}>返回番剧</Link></>}
      </div>
    </> : <Player key={`${mediaId}:${navigationKey}:${info.data.version}`} mediaId={mediaId} info={info.data}
      showTitle={title} episodeTitle={subtitle} backTo={backTo} artwork={artwork} library={library.data}
      libraryLoading={library.isPending} libraryError={library.error?.message} onRetryLibrary={() => void library.refetch()}
      fullscreenTarget={fullscreenTarget} autoPlay={state?.autoPlay === true}
      savedPreferences={preferences} onPreferencesChange={setPreferences}
      onSelectEpisode={id => navigate(`/watch/${id}`, { state: { autoPlay: true } })}/>
    }
  </main>
}
