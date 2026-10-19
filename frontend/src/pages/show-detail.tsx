import { useEffect, useRef, useState } from "react"
import { Link, useLocation, useParams } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, CheckCircle2, ExternalLink, FolderOpen, ImageOff, MoreHorizontal, Pencil, RefreshCw, Star, Upload } from "lucide-react"
import { api, ApiError, type ShowDetail, type ShowLibrary } from "@/lib/api"
import { artworkUrl, posterUrl, showReturnState } from "@/lib/show-artwork"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ArtworkUpload } from "@/components/artwork-upload"
import { EditSubscriptionDialog } from "@/components/edit-subscription-dialog"
import { ShowDetailLoading } from "@/components/show-detail-loading"
import { ShowEpisodeList } from "@/components/show-episode-list"
import { ShowOverview } from "@/components/show-overview"
import { useToast } from "@/components/ui/toast"
import "./show-detail.css"

export function ShowDetailPage() {
  const { sourceId = "" } = useParams()
  const valid = /^[1-9]\d*$/.test(sourceId) && Number.isSafeInteger(Number(sourceId))
  // 路由变化时重新挂载局部状态，避免前一部作品的季度、图片或弹窗短暂泄漏。
  return <DetailContent key={sourceId} sourceId={Number(sourceId)} valid={valid}/>
}

function DetailContent({ sourceId, valid }: { sourceId: number; valid: boolean }) {
  const location = useLocation()
  const back = showReturnState(location.state)
  const client = useQueryClient()
  const toast = useToast()
  const [selectedTab, setSelectedTab] = useState<string | null>(null)
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const [upload, setUpload] = useState(false)
  const [editing, setEditing] = useState(false)
  const [failedPoster, setFailedPoster] = useState<string>()
  const [failedBackdrop, setFailedBackdrop] = useState<string>()
  const detail = useQuery({ queryKey: ["shows", "detail", sourceId], queryFn: () => api<ShowDetail>(`/shows/${sourceId}`), enabled: valid, retry: false })
  const library = useQuery({ queryKey: ["shows", "library", sourceId], queryFn: () => api<ShowLibrary>(`/shows/${sourceId}/library`), enabled: valid && Boolean(detail.data), refetchInterval: 15000 })
  useEffect(() => { window.scrollTo(0, 0) }, [])
  const action = useMutation({
    mutationFn: (kind: "folder" | "rescrape" | "refresh") => api<{ message?: string }>(kind === "refresh" ? `/feeds/${sourceId}/refresh` : `/shows/${sourceId}/${kind === "folder" ? "open-folder" : "rescrape"}`, { method: "POST" }),
    onSuccess: (result, kind) => {
      toast(result.message ?? (kind === "refresh" ? "订阅已刷新" : "已提交重新刮削，可在提醒中心查看进度"))
      for (const key of ["shows", "feeds", "notifications", "dashboard"]) void client.invalidateQueries({ queryKey: [key] })
    },
    onError: error => toast("操作失败", { description: error.message, tone: "error" }),
  })
  const returnLink = <Link to={back.from} state={{ restoreShowList: back }} className="detail-back"><ArrowLeft size={18}/><span>番剧</span><span className="text-[var(--muted)]">/ 详情</span></Link>
  if (!valid || (detail.isError && (!detail.data || (detail.error instanceof ApiError && detail.error.status === 404)))) return <div className="show-detail">{returnLink}<section className="detail-error" role="alert"><ImageOff size={32}/><h1>{!valid ? "无效的番剧地址" : detail.error instanceof ApiError && detail.error.status === 404 ? "番剧订阅不存在" : "详情加载失败"}</h1><p>{!valid ? "请通过番剧列表打开有效的订阅。" : detail.error?.message}</p><div><Button asChild variant="secondary"><Link to={back.from} state={{ restoreShowList: back }}>返回番剧列表</Link></Button>{valid && !(detail.error instanceof ApiError && detail.error.status === 404) && <Button onClick={() => void detail.refetch()}>重试</Button>}</div></section></div>
  if (!detail.data) return <ShowDetailLoading/>
  const show = detail.data
  const feed = show.subscription
  const seasons = library.data?.seasons.length ? library.data.seasons : [{ season: show.media_type === "movie" ? null : feed.season ?? null, items: [] }]
  const seasonKey = (season: number | null) => `season-${season ?? "unknown"}`
  const preferred = seasons.find(group => group.season === feed.season) ?? seasons[0]
  const tabItems = [...seasons.map(group => ({ key: seasonKey(group.season), label: show.media_type === "movie" ? "影片" : group.season === 0 ? "特别篇" : group.season == null ? "视频文件" : `第 ${group.season} 季`, count: group.items.length })), { key: "subscription", label: "订阅信息", count: undefined }]
  const activeKey = selectedTab && tabItems.some(item => item.key === selectedTab) ? selectedTab : seasonKey(preferred.season)

  const poster = posterUrl(show)
  const backdrop = show.fanart_ready ? artworkUrl(show, "fanart") : undefined
  const ready = [show.poster_ready, show.fanart_ready, show.clearlogo_ready].filter(Boolean).length
  const tmdb = show.tmdb_url && /^https?:\/\//i.test(show.tmdb_url) ? show.tmdb_url : undefined
  return <div className="show-detail">
    {backdrop && failedBackdrop !== backdrop && <img className="detail-backdrop" src={backdrop} alt="" onError={() => setFailedBackdrop(backdrop)}/>}
    {returnLink}
    {detail.isError && <p role="status" className="mb-4 text-sm text-[var(--warning)]">详情更新失败，当前显示上次读取的内容。<button className="ml-2 underline" onClick={() => void detail.refetch()}>重试</button></p>}
    <div className="detail-grid">
      <aside className="detail-artwork"><div className="detail-poster">{poster && failedPoster !== poster ? <img src={poster} alt={`${show.name} 海报`} onError={() => setFailedPoster(poster)}/> : <div className="detail-no-poster"><ImageOff size={42}/><span>{show.name}</span><small>暂无海报</small></div>}</div><button className="detail-manage" onClick={() => setUpload(true)}><Upload size={18}/>管理图片</button><div className="detail-artwork-state"><span>海报 · 背景图 · 透明 Logo</span><span>{ready === 3 ? "素材已就绪" : `${ready} / 3 项素材已就绪`}{ready === 3 && <CheckCircle2 size={17}/>}</span></div></aside>
      <div className="detail-main">
        <div className="detail-kicker">{show.media_type === "movie" ? "电影" : show.media_type === "tv" ? "电视剧" : "媒体详情"}{show.tmdb_id != null && <span> · TMDB #{show.tmdb_id}</span>}</div>
        <h1>{show.name}</h1>
        <div className="detail-facts">{show.rating != null && <span className="detail-rating"><Star size={20} fill="currentColor"/>{show.rating.toFixed(1)}{show.vote_count != null && <small>（{show.vote_count} 人评分）</small>}</span>}{show.release_date && <span>{show.release_date.slice(0, 4)}</span>}{show.media_type !== "movie" && show.episode_count != null && <span>TMDB 共 {show.episode_count} 集</span>}{library.data && <span>本地 {library.data.total} 个视频</span>}</div>
        {show.genres.length > 0 && <p className="detail-genres">{show.genres.join(" / ")}</p>}
        <ShowOverview overview={show.overview}/>
        <div className="detail-actions">
          <DropdownMenu>
            {/* 按钮是菜单的定位锚点，按压缩放会让弹出层跟随横移。 */}
            <DropdownMenuTrigger asChild><Button variant="secondary" icon={MoreHorizontal} pressMotion={false}>更多操作</Button></DropdownMenuTrigger>
            <DropdownMenuContent align="start" animateSize>
              <DropdownMenuItem disabled={action.isPending} onSelect={() => action.mutate("folder")}><FolderOpen size={16}/>{action.isPending && action.variables === "folder" ? "打开中…" : "打开文件夹"}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setEditing(true)}><Pencil size={16}/>编辑订阅</DropdownMenuItem>
              <DropdownMenuItem disabled={action.isPending || !show.tmdb_id} onSelect={() => action.mutate("rescrape")}><RefreshCw size={16}/>重新刮削</DropdownMenuItem>
              {feed.kind !== "magnet" && <DropdownMenuItem disabled={action.isPending} onSelect={() => action.mutate("refresh")}><RefreshCw size={16}/>刷新 RSS</DropdownMenuItem>}
              {tmdb && <DropdownMenuItem asChild><a href={tmdb} target="_blank" rel="noopener noreferrer"><ExternalLink size={16}/>在 TMDB 查看</a></DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="detail-tabs" role="tablist" aria-label="季度与订阅信息">{tabItems.map((item, index) => <button key={item.key} ref={element => { tabs.current[index] = element }} role="tab" id={`detail-tab-${item.key}`} aria-controls={`detail-panel-${item.key}`} aria-selected={activeKey === item.key} tabIndex={activeKey === item.key ? 0 : -1} onClick={() => setSelectedTab(item.key)} onKeyDown={event => {
          if (["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) {
            event.preventDefault()
            const next = event.key === "Home" ? 0 : event.key === "End" ? tabItems.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabItems.length) % tabItems.length
            setSelectedTab(tabItems[next].key)
            tabs.current[next]?.focus()
          }
        }}>{item.label}{item.count != null && library.data && <span>{item.count}</span>}</button>)}</div>
        {seasons.map(group => <section key={seasonKey(group.season)} role="tabpanel" id={`detail-panel-${seasonKey(group.season)}`} aria-labelledby={`detail-tab-${seasonKey(group.season)}`} hidden={activeKey !== seasonKey(group.season)} tabIndex={0} className="detail-panel">
          {library.isPending && <p className="detail-empty" role="status">正在读取作品文件夹…</p>}
          {library.isError && <p className="detail-empty" role="alert">文件读取失败：{library.error.message} <button className="underline" onClick={() => void library.refetch()}>重试</button></p>}
          {library.data?.partial && <p className="episode-notice" role="status">部分文件夹无法读取，当前显示可读取的视频。</p>}
          {library.data && group.items.length === 0 && <p className="detail-empty">{library.data.available ? "这个季度的文件夹中还没有视频文件。" : "作品文件夹尚未创建或媒体库未挂载。"}</p>}
          {group.items.length > 0 && <ShowEpisodeList key={seasonKey(group.season)} show={show} items={group.items}/>}
        </section>)}
        <section role="tabpanel" id="detail-panel-subscription" aria-labelledby="detail-tab-subscription" hidden={activeKey !== "subscription"} tabIndex={0} className="detail-panel">
          <div className="detail-subscription"><dl><div><dt>来源类型</dt><dd>{feed.kind === "magnet" ? "磁力合集" : feed.kind === "mikan" ? "Mikan Project" : "标准 RSS / Atom"}</dd></div><div><dt>启用状态</dt><dd>{feed.active ? "已启用" : "已停用"}</dd></div><div><dt>季度</dt><dd>{feed.season == null ? "自动识别" : feed.season === 0 ? "特别篇（第 0 季）" : `第 ${feed.season} 季`}</dd></div>{feed.kind !== "magnet" && <><div><dt>刷新间隔</dt><dd>{feed.refresh_interval_minutes} 分钟</dd></div><div><dt>最近检查</dt><dd>{feed.last_checked_at ? new Date(feed.last_checked_at).toLocaleString("zh-CN") : "尚未检查"}</dd></div><div><dt>连接状态</dt><dd>{({ healthy: "连接正常", connected: "连接正常", ok: "连接正常", error: "连接异常", failed: "连接异常", unknown: "尚未检查" } as Record<string, string>)[feed.connection_status] ?? feed.connection_status}</dd></div></>}<div><dt>排除关键词</dt><dd>{feed.excluded_keywords.length ? feed.excluded_keywords.join("、") : "未设置"}</dd></div>{show.metadata_scraped_at && <div><dt>元数据更新</dt><dd>{new Date(show.metadata_scraped_at).toLocaleString("zh-CN")}</dd></div>}</dl>{feed.kind !== "magnet" && feed.last_error && <p role="alert" className="text-[var(--danger)]">{feed.last_error}</p>}<Button variant="secondary" icon={Pencil} onClick={() => setEditing(true)}>编辑订阅</Button></div>
        </section>
      </div>
    </div>
    <ArtworkUpload show={upload ? show : null} onClose={() => setUpload(false)}/>{editing && <EditSubscriptionDialog feed={feed} onClose={() => setEditing(false)}/>}
  </div>
}
