import { useEffect, useState } from "react"
import { Link, useLocation, useParams } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, ImageOff } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { api, ApiError, type ShowDetail, type ShowLibrary } from "@/lib/api"
import { artworkUrl, posterUrl, showReturnState } from "@/lib/show-artwork"
import { spring } from "@/lib/motion"
import { Button } from "@/components/ui/button"
import { ArtworkUpload } from "@/components/artwork-upload"
import { EditSubscriptionDialog } from "@/components/edit-subscription-dialog"
import { ShowDetailLoading } from "@/components/show-detail-loading"
import { ShowEpisodeList } from "@/components/show-episode-list"
import { ShowDetailPanels } from "@/components/show-detail-panels"
import { ShowDetailTabs } from "@/components/show-detail-tabs"
import { ShowOverview } from "@/components/show-overview"
import { DetailHeader } from "@/components/show-detail/detail-header"
import { DetailActions } from "@/components/show-detail/detail-actions"
import { SubscriptionInfoPanel } from "@/components/show-detail/subscription-info-panel"
import { useToast } from "@/components/ui/toast"
import { RetryImage } from "@/components/ui/retry-image"
import { FadeSlide } from "@/components/ui/fade-slide"
import "./show-detail.css"

export function ShowDetailPage() {
  const { sourceId = "" } = useParams()
  const valid = /^[1-9]\d*$/.test(sourceId) && Number.isSafeInteger(Number(sourceId))
  // 路由变化时重新挂载局部状态，避免前一部作品的季度、图片或弹窗短暂泄漏。
  return <DetailContent key={sourceId} sourceId={Number(sourceId)} valid={valid} />
}

function DetailContent({ sourceId, valid }: { sourceId: number; valid: boolean }) {
  const location = useLocation()
  const back = showReturnState(location.state)
  const client = useQueryClient()
  const toast = useToast()
  const reducedMotion = useReducedMotion()
  const [selectedTab, setSelectedTab] = useState<string | null>(null)
  const [upload, setUpload] = useState(false)
  const [editing, setEditing] = useState(false)
  const detail = useQuery({
    queryKey: ["shows", "detail", sourceId],
    queryFn: () => api<ShowDetail>(`/shows/${sourceId}`),
    enabled: valid,
    retry: false,
  })
  const library = useQuery({
    queryKey: ["shows", "library", sourceId],
    queryFn: () => api<ShowLibrary>(`/shows/${sourceId}/library`),
    enabled: valid && Boolean(detail.data),
    refetchInterval: 15000,
  })
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [])
  const action = useMutation({
    mutationFn: (kind: "folder" | "rescrape" | "refresh") =>
      api<{ message?: string }>(
        kind === "refresh"
          ? `/feeds/${sourceId}/refresh`
          : `/shows/${sourceId}/${kind === "folder" ? "open-folder" : "rescrape"}`,
        { method: "POST" },
      ),
    onSuccess: (result, kind) => {
      toast(result.message ?? (kind === "refresh" ? "订阅已刷新" : "已提交重新刮削，可在提醒中心查看进度"))
      for (const key of ["shows", "feeds", "notifications", "dashboard"])
        void client.invalidateQueries({ queryKey: [key] })
    },
    onError: (error) => toast("操作失败", { description: error.message, tone: "error" }),
  })
  const returnLink = (
    <Link to={back.from} state={{ restoreShowList: back }} className="detail-back">
      <ArrowLeft size={16} />
      <span>番剧</span>
      <span className="text-muted">/ 详情</span>
    </Link>
  )
  if (!valid || (detail.isError && (!detail.data || (detail.error instanceof ApiError && detail.error.status === 404))))
    return (
      <div className="show-detail">
        {returnLink}
        <section className="detail-error" role="alert">
          <ImageOff size={32} />
          <h1>
            {!valid
              ? "无效的番剧地址"
              : detail.error instanceof ApiError && detail.error.status === 404
                ? "番剧订阅不存在"
                : "详情加载失败"}
          </h1>
          <p>{!valid ? "请通过番剧列表打开有效的订阅。" : detail.error?.message}</p>
          <div>
            <Button asChild variant="secondary">
              <Link to={back.from} state={{ restoreShowList: back }}>
                返回番剧列表
              </Link>
            </Button>
            {valid && !(detail.error instanceof ApiError && detail.error.status === 404) && (
              <Button onClick={() => void detail.refetch()}>重试</Button>
            )}
          </div>
        </section>
      </div>
    )
  if (!detail.data) return <ShowDetailLoading />
  const show = detail.data
  const feed = show.subscription
  const seasons = library.data?.seasons.length
    ? library.data.seasons
    : [{ season: show.media_type === "movie" ? null : (feed.season ?? null), items: [] }]
  const seasonKey = (season: number | null) => `season-${season ?? "unknown"}`
  const preferred = seasons.find((group) => group.season === feed.season) ?? seasons[0]
  const tabItems = [
    ...seasons.map((group) => ({
      key: seasonKey(group.season),
      label:
        show.media_type === "movie"
          ? "影片"
          : group.season === 0
            ? "特别篇"
            : group.season == null
              ? "视频文件"
              : `第 ${group.season} 季`,
      count: library.data ? group.items.length : undefined,
    })),
    { key: "subscription", label: "订阅信息", count: undefined },
  ]
  const activeKey =
    selectedTab && tabItems.some((item) => item.key === selectedTab) ? selectedTab : seasonKey(preferred.season)
  const activeSeason = seasons.find((group) => seasonKey(group.season) === activeKey) ?? preferred

  const poster = posterUrl(show)
  const backdrop = show.fanart_ready ? artworkUrl(show, "fanart") : undefined
  const noPoster = (
    <span className="detail-no-poster">
      <ImageOff size={42} />
      <span>{show.name}</span>
      <small>暂无海报</small>
    </span>
  )
  return (
    <div className="show-detail">
      {backdrop && (
        <div className="detail-backdrop-stage" aria-hidden="true">
          <RetryImage className="detail-backdrop" src={backdrop} alt="" />
          <div className="media-scrim media-scrim--backdrop" />
        </div>
      )}
      {returnLink}
      {detail.isError && (
        <p role="status" className="mb-4 text-sm text-warning">
          详情更新失败，当前显示上次读取的内容。
          <button className="ml-2 underline" onClick={() => void detail.refetch()}>
            重试
          </button>
        </p>
      )}
      <FadeSlide
        className="detail-grid"
        selector=".detail-poster, .detail-kicker, .detail-title, .detail-facts, .detail-genres, .detail-primary-actions, .detail-overview, .episode-list > li, .detail-subscription dl > div"
      >
        <aside className="detail-artwork">
          <div className="detail-poster">
            {poster ? <RetryImage src={poster} alt={`${show.name} 海报`} fallback={noPoster} /> : noPoster}
          </div>
        </aside>
        <div className="detail-main">
          <DetailHeader show={show} library={library.data} />
          <DetailActions
            show={show}
            items={activeSeason.items}
            pending={action.isPending}
            pendingAction={action.variables}
            onAction={(kind) => action.mutate(kind)}
            onEdit={() => setEditing(true)}
            onUpload={() => setUpload(true)}
          />
          <ShowOverview overview={show.overview} />
          <ShowDetailTabs items={tabItems} activeKey={activeKey} onSelect={setSelectedTab} />
          <ShowDetailPanels activeKey={activeKey}>
            {seasons.map((group) => (
              <motion.section
                key={seasonKey(group.season)}
                initial={false}
                animate={{
                  opacity: activeKey === seasonKey(group.season) ? 1 : 0,
                  y: activeKey === seasonKey(group.season) ? 0 : 8,
                }}
                transition={reducedMotion ? { duration: 0 } : spring.gentle}
                role="tabpanel"
                id={`detail-panel-${seasonKey(group.season)}`}
                aria-labelledby={`detail-tab-${seasonKey(group.season)}`}
                hidden={activeKey !== seasonKey(group.season)}
                tabIndex={0}
                className="detail-panel"
              >
                {library.isPending && (
                  <p className="detail-empty" role="status">
                    正在读取作品文件夹…
                  </p>
                )}
                {library.isError && (
                  <p className="detail-empty" role="alert">
                    文件读取失败：{library.error.message}{" "}
                    <button className="underline" onClick={() => void library.refetch()}>
                      重试
                    </button>
                  </p>
                )}
                {library.data?.partial && (
                  <p className="episode-notice" role="status">
                    部分文件夹无法读取，当前显示可读取的视频。
                  </p>
                )}
                {library.data && group.items.length === 0 && (
                  <p className="detail-empty">
                    {library.data.available
                      ? "这个季度的文件夹中还没有视频文件。"
                      : "作品文件夹尚未创建或媒体库未挂载。"}
                  </p>
                )}
                {group.items.length > 0 && (
                  <ShowEpisodeList key={seasonKey(group.season)} show={show} items={group.items} />
                )}
              </motion.section>
            ))}
            <motion.section
              initial={false}
              animate={{ opacity: activeKey === "subscription" ? 1 : 0, y: activeKey === "subscription" ? 0 : 8 }}
              transition={reducedMotion ? { duration: 0 } : spring.gentle}
              role="tabpanel"
              id="detail-panel-subscription"
              aria-labelledby="detail-tab-subscription"
              hidden={activeKey !== "subscription"}
              tabIndex={0}
              className="detail-panel"
            >
              <SubscriptionInfoPanel show={show} onEdit={() => setEditing(true)} />
            </motion.section>
          </ShowDetailPanels>
        </div>
      </FadeSlide>
      <ArtworkUpload show={upload ? show : null} onClose={() => setUpload(false)} />
      {editing && <EditSubscriptionDialog feed={feed} onClose={() => setEditing(false)} />}
    </div>
  )
}
