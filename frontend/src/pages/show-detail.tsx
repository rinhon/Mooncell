import { useEffect, useState } from "react"
import { Link, useLocation, useParams } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, ExternalLink, FolderOpen, ImageOff, MoreHorizontal, Pencil, RefreshCw, Star } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { api, ApiError, type ShowDetail, type ShowLibrary } from "@/lib/api"
import { artworkUrl, posterUrl, showReturnState } from "@/lib/show-artwork"
import { Button } from "@/components/ui/button"
import SpecularButton from "@/components/ui/specular-button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ArtworkUpload } from "@/components/artwork-upload"
import { EditSubscriptionDialog } from "@/components/edit-subscription-dialog"
import { ShowDetailLoading } from "@/components/show-detail-loading"
import { ShowEpisodeList } from "@/components/show-episode-list"
import { ShowDetailPanels } from "@/components/show-detail-panels"
import { ShowDetailTabs } from "@/components/show-detail-tabs"
import { ShowOverview } from "@/components/show-overview"
import { GradualBlur } from "@/components/ui/gradual-blur"
import { useToast } from "@/components/ui/toast"
import { useTheme } from "@/lib/theme"
import "./show-detail.css"

export function ShowDetailPage() {
  const { sourceId = "" } = useParams()
  const valid = /^[1-9]\d*$/.test(sourceId) && Number.isSafeInteger(Number(sourceId))
  // 路由变化时重新挂载局部状态，避免前一部作品的季度、图片或弹窗短暂泄漏。
  return <DetailContent key={sourceId} sourceId={Number(sourceId)} valid={valid}/>
}

function DetailContent({ sourceId, valid }: { sourceId: number; valid: boolean }) {
  const { theme, palette } = useTheme()
  const location = useLocation()
  const back = showReturnState(location.state)
  const client = useQueryClient()
  const toast = useToast()
  const reducedMotion = useReducedMotion()
  const [selectedTab, setSelectedTab] = useState<string | null>(null)
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
  const returnLink = <Link to={back.from} state={{ restoreShowList: back }} className="detail-back"><ArrowLeft size={16}/><span>番剧</span><span className="text-[var(--muted)]">/ 详情</span></Link>
  if (!valid || (detail.isError && (!detail.data || (detail.error instanceof ApiError && detail.error.status === 404)))) return <div className="show-detail">{returnLink}<section className="detail-error" role="alert"><ImageOff size={32}/><h1>{!valid ? "无效的番剧地址" : detail.error instanceof ApiError && detail.error.status === 404 ? "番剧订阅不存在" : "详情加载失败"}</h1><p>{!valid ? "请通过番剧列表打开有效的订阅。" : detail.error?.message}</p><div><Button asChild variant="secondary"><Link to={back.from} state={{ restoreShowList: back }}>返回番剧列表</Link></Button>{valid && !(detail.error instanceof ApiError && detail.error.status === 404) && <Button onClick={() => void detail.refetch()}>重试</Button>}</div></section></div>
  if (!detail.data) return <ShowDetailLoading/>
  const show = detail.data
  const feed = show.subscription
  const seasons = library.data?.seasons.length ? library.data.seasons : [{ season: show.media_type === "movie" ? null : feed.season ?? null, items: [] }]
  const seasonKey = (season: number | null) => `season-${season ?? "unknown"}`
  const preferred = seasons.find(group => group.season === feed.season) ?? seasons[0]
  const tabItems = [...seasons.map(group => ({ key: seasonKey(group.season), label: show.media_type === "movie" ? "影片" : group.season === 0 ? "特别篇" : group.season == null ? "视频文件" : `第 ${group.season} 季`, count: library.data ? group.items.length : undefined })), { key: "subscription", label: "订阅信息", count: undefined }]
  const activeKey = selectedTab && tabItems.some(item => item.key === selectedTab) ? selectedTab : seasonKey(preferred.season)

  const poster = posterUrl(show)
  const backdrop = show.fanart_ready ? artworkUrl(show, "fanart") : undefined
  const tmdb = show.tmdb_url && /^https?:\/\//i.test(show.tmdb_url) ? show.tmdb_url : undefined
  return <div className="show-detail">
    {backdrop && failedBackdrop !== backdrop && <div className="detail-backdrop-stage" aria-hidden="true">
      <img className="detail-backdrop" src={backdrop} alt="" onError={() => setFailedBackdrop(backdrop)}/>
      <GradualBlur position="bottom" height="22%" strength={2} divCount={4} exponential curve="bezier" tint="var(--detail-backdrop-blur-tint)" className="detail-backdrop-blur"/>
    </div>}
    {returnLink}
    {detail.isError && <p role="status" className="mb-4 text-sm text-[var(--warning)]">详情更新失败，当前显示上次读取的内容。<button className="ml-2 underline" onClick={() => void detail.refetch()}>重试</button></p>}
    <div className="detail-grid">
      <aside className="detail-artwork"><motion.button type="button" className="detail-poster" aria-label={`编辑 ${show.name} 的图片`} title="点击编辑图片" onClick={() => setUpload(true)} whileHover={reducedMotion ? undefined : { filter: "brightness(1.08)" }} whileTap={reducedMotion ? undefined : { scale: .99 }}>{poster && failedPoster !== poster ? <img src={poster} alt={`${show.name} 海报`} onError={() => setFailedPoster(poster)}/> : <span className="detail-no-poster"><ImageOff size={42}/><span>{show.name}</span><small>暂无海报 · 点击添加图片</small></span>}</motion.button></aside>
      <div className="detail-main">
        <div className="detail-kicker">{show.media_type === "movie" ? "电影" : show.media_type === "tv" ? "电视剧" : "媒体详情"}{show.tmdb_id != null && <span> · TMDB #{show.tmdb_id}</span>}</div>
        <div className="detail-title">
          <h1>{show.name}</h1>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><SpecularButton className="detail-title-menu" size="sm" radius={12} tint={theme === "ocean" ? palette.accent : "#7ee7a3"} tintOpacity={.05} textColor={theme === "ocean" ? palette.ink : "#dce9df"} lineColor={theme === "ocean" ? palette.accent : "#a7f3c2"} baseColor={theme === "ocean" ? palette.secondary : "#405248"} blur={8} followMouse={!reducedMotion} aria-label="作品操作" title="作品操作"><MoreHorizontal size={22} aria-hidden="true"/></SpecularButton></DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="start" animateSize>
              <DropdownMenuItem disabled={action.isPending} onSelect={() => action.mutate("folder")}><FolderOpen size={16}/>{action.isPending && action.variables === "folder" ? "打开中…" : "打开文件夹"}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setEditing(true)}><Pencil size={16}/>编辑订阅</DropdownMenuItem>
              <DropdownMenuItem disabled={action.isPending || !show.tmdb_id} onSelect={() => action.mutate("rescrape")}><RefreshCw size={16}/>重新刮削</DropdownMenuItem>
              {feed.kind !== "magnet" && <DropdownMenuItem disabled={action.isPending} onSelect={() => action.mutate("refresh")}><RefreshCw size={16}/>刷新 RSS</DropdownMenuItem>}
              {tmdb && <DropdownMenuItem asChild><a href={tmdb} target="_blank" rel="noopener noreferrer"><ExternalLink size={16}/>在 TMDB 查看</a></DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="detail-facts">{show.rating != null && <span className="detail-rating"><Star size={20} fill="currentColor"/>{show.rating.toFixed(1)}{show.vote_count != null && <small>（{show.vote_count} 人评分）</small>}</span>}{show.release_date && <span>{show.release_date.slice(0, 4)}</span>}{show.media_type !== "movie" && show.episode_count != null && <span>TMDB 共 {show.episode_count} 集</span>}{library.data && <span>本地 {library.data.total} 个视频</span>}</div>
        {show.genres.length > 0 && <p className="detail-genres">{show.genres.join(" / ")}</p>}
        <ShowOverview overview={show.overview}/>
        <ShowDetailTabs items={tabItems} activeKey={activeKey} onSelect={setSelectedTab}/>
        <ShowDetailPanels activeKey={activeKey}>
        {seasons.map(group => <motion.section key={seasonKey(group.season)} initial={false} animate={{ opacity: activeKey === seasonKey(group.season) ? 1 : 0, y: activeKey === seasonKey(group.season) ? 0 : 8 }} transition={{ duration: reducedMotion ? 0 : .22 }} role="tabpanel" id={`detail-panel-${seasonKey(group.season)}`} aria-labelledby={`detail-tab-${seasonKey(group.season)}`} hidden={activeKey !== seasonKey(group.season)} tabIndex={0} className="detail-panel">
          {library.isPending && <p className="detail-empty" role="status">正在读取作品文件夹…</p>}
          {library.isError && <p className="detail-empty" role="alert">文件读取失败：{library.error.message} <button className="underline" onClick={() => void library.refetch()}>重试</button></p>}
          {library.data?.partial && <p className="episode-notice" role="status">部分文件夹无法读取，当前显示可读取的视频。</p>}
          {library.data && group.items.length === 0 && <p className="detail-empty">{library.data.available ? "这个季度的文件夹中还没有视频文件。" : "作品文件夹尚未创建或媒体库未挂载。"}</p>}
          {group.items.length > 0 && <ShowEpisodeList key={seasonKey(group.season)} show={show} items={group.items}/>}
        </motion.section>)}
        <motion.section initial={false} animate={{ opacity: activeKey === "subscription" ? 1 : 0, y: activeKey === "subscription" ? 0 : 8 }} transition={{ duration: reducedMotion ? 0 : .22 }} role="tabpanel" id="detail-panel-subscription" aria-labelledby="detail-tab-subscription" hidden={activeKey !== "subscription"} tabIndex={0} className="detail-panel">
          <div className="detail-subscription"><dl><div><dt>来源类型</dt><dd>{feed.kind === "magnet" ? "磁力合集" : feed.kind === "mikan" ? "Mikan Project" : "标准 RSS / Atom"}</dd></div><div><dt>启用状态</dt><dd>{feed.active ? "已启用" : "已停用"}</dd></div><div><dt>季度</dt><dd>{feed.season == null ? "自动识别" : feed.season === 0 ? "特别篇（第 0 季）" : `第 ${feed.season} 季`}</dd></div>{feed.kind !== "magnet" && <><div><dt>刷新间隔</dt><dd>{feed.refresh_interval_minutes} 分钟</dd></div><div><dt>最近检查</dt><dd>{feed.last_checked_at ? new Date(feed.last_checked_at).toLocaleString("zh-CN") : "尚未检查"}</dd></div><div><dt>连接状态</dt><dd>{({ healthy: "连接正常", connected: "连接正常", ok: "连接正常", error: "连接异常", failed: "连接异常", unknown: "尚未检查" } as Record<string, string>)[feed.connection_status] ?? feed.connection_status}</dd></div></>}<div><dt>排除关键词</dt><dd>{feed.excluded_keywords.length ? feed.excluded_keywords.join("、") : "未设置"}</dd></div>{show.metadata_scraped_at && <div><dt>元数据更新</dt><dd>{new Date(show.metadata_scraped_at).toLocaleString("zh-CN")}</dd></div>}</dl>{feed.kind !== "magnet" && feed.last_error && <p role="alert" className="text-[var(--danger)]">{feed.last_error}</p>}<Button variant="secondary" icon={Pencil} onClick={() => setEditing(true)}>编辑订阅</Button></div>
        </motion.section>
        </ShowDetailPanels>
      </div>
    </div>
    <ArtworkUpload show={upload ? show : null} onClose={() => setUpload(false)}/>{editing && <EditSubscriptionDialog feed={feed} onClose={() => setEditing(false)}/>}
  </div>
}
