import { ArtworkUpload } from "@/components/artwork-upload"
import { ShowsHeader, ShowsLoading, type ShowsView } from "@/components/shows-loading"
import { usePageLoadCycle, usePageReady } from "@/components/page-load-boundary"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ImageOff, LoaderCircle } from "lucide-react"
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom"
import { api, type Show } from "@/lib/api"
import { showReturnState } from "@/lib/show-artwork"
import { ShowCard } from "@/components/shows/show-card"
import { ShowPosterTile } from "@/components/shows/show-poster-tile"
import { Masonry } from "@/components/ui/masonry"
import { ShowRow } from "@/components/shows/show-row"
import { Card, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useToast } from "@/components/ui/toast"

const viewStorageKey = "mooncell-shows-view"
function isShowsView(value: unknown): value is ShowsView {
  return value === "cards" || value === "posters" || value === "list"
}
function readPreferredView(): ShowsView {
  try {
    const value = window.localStorage.getItem(viewStorageKey)
    if (isShowsView(value)) return value
  } catch {
    // 浏览器禁用存储时仍可正常使用视图切换。
  }
  return "cards"
}
function initialView(state: unknown): ShowsView {
  if (state && typeof state === "object" && "view" in state && isShowsView(state.view)) {
    const restoredView = showReturnState(state).view
    if (restoredView) return restoredView
  }
  return readPreferredView()
}

/** 将 RSS 订阅、TMDB 元数据和本地三图组合成真实番剧媒体库。 */
export function ShowsPage() {
  const pageReady = usePageReady()
  const location = useLocation()
  const navigate = useNavigate()
  const restore = showReturnState(location.state?.restoreShowList)
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState(() => params.get("q") ?? "")
  const [view, setView] = useState<ShowsView>(() => initialView(location.state?.restoreShowList))
  usePageLoadCycle(view, <ShowsLoading query={query} view={view} filtered={params.has("id")} />)
  function changeView(next: ShowsView) {
    setView(next)
    try {
      window.localStorage.setItem(viewStorageKey, next)
    } catch {
      /* 存储不可用时保留当前页面偏好。 */
    }
  }
  const [uploadId, setUploadId] = useState<number | null>(null)
  const [itemsShow, setItemsShow] = useState<Show | null>(null)
  const client = useQueryClient()
  const toast = useToast()
  const showsQuery = useQuery({ queryKey: ["shows"], queryFn: () => api<Show[]>("/shows") })
  const itemTitlesQuery = useQuery({
    queryKey: ["shows", itemsShow?.id, "items"],
    queryFn: () => api<string[]>(`/shows/${itemsShow!.id}/items`),
    enabled: itemsShow !== null,
  })
  const rescrape = useMutation({
    mutationFn: (id: number) => api<Show>(`/shows/${id}/rescrape`, { method: "POST" }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["shows"] })
      client.invalidateQueries({ queryKey: ["feeds"] })
      client.invalidateQueries({ queryKey: ["notifications"] })
    },
  })
  const openFolder = useMutation({
    mutationFn: (id: number) => api<{ message: string }>(`/shows/${id}/open-folder`, { method: "POST" }),
    onSuccess: (result) => toast(result.message),
    onError: () => toast("无法打开番剧文件夹", { description: "请确认目录已经创建，并查看实时日志。", tone: "error" }),
  })
  const shows = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return (showsQuery.data ?? []).filter((show) =>
      `${show.name}${show.metadata_title ?? ""}`.toLowerCase().includes(normalized),
    )
  }, [query, showsQuery.data, params])

  const restoredScroll = useRef(false)
  useLayoutEffect(() => {
    if (!pageReady || !showsQuery.data || restoredScroll.current) return
    // 骨架结束、真实内容恢复高度后再还原滚动位置。
    const frame = window.requestAnimationFrame(() => {
      window.scrollTo({ top: restore.scrollY ?? 0, behavior: "instant" })
      restoredScroll.current = true
    })
    return () => window.cancelAnimationFrame(frame)
  }, [pageReady, showsQuery.data, restore.scrollY])
  useEffect(() => {
    setQuery(params.get("q") ?? "")
  }, [params])
  const returnState = useMemo(
    () => ({
      from: `/shows${query ? `?${new URLSearchParams({ q: query })}` : ""}`,
      view,
    }),
    [query, view],
  )
  const openDetail = useCallback(
    (event: MouseEvent<HTMLAnchorElement>, id: number) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      const context = { ...returnState, scrollY: window.scrollY }
      navigate(context.from, { replace: true, state: { restoreShowList: context } })
      navigate(`/shows/${id}`, { state: context })
    },
    [navigate, returnState],
  )
  const handleRescrape = useCallback((id: number) => rescrape.mutate(id), [rescrape.mutate])
  const handleOpenFolder = useCallback((id: number) => openFolder.mutate(id), [openFolder.mutate])
  const rescrapePendingId = rescrape.isPending ? rescrape.variables : null
  const openFolderPendingId = openFolder.isPending ? openFolder.variables : null
  const posterTiles = useMemo(
    () =>
      view === "posters"
        ? shows.map((show, index) => (
            <ShowPosterTile
              key={show.id}
              show={show}
              index={index}
              returnState={returnState}
              openDetail={openDetail}
              onUpload={setUploadId}
              onItems={setItemsShow}
              onRescrape={handleRescrape}
              onOpenFolder={handleOpenFolder}
              rescraping={rescrapePendingId === show.id}
              openingFolder={openFolderPendingId === show.id}
            />
          ))
        : null,
    [view, shows, returnState, openDetail, handleRescrape, handleOpenFolder, rescrapePendingId, openFolderPendingId],
  )
  const cardTiles = useMemo(
    () =>
      view === "cards"
        ? shows.map((show, index) => (
            <ShowCard
              key={show.id}
              show={show}
              index={index}
              returnState={returnState}
              openDetail={openDetail}
              onUpload={setUploadId}
              onItems={setItemsShow}
              onRescrape={handleRescrape}
              onOpenFolder={handleOpenFolder}
              rescraping={rescrapePendingId === show.id}
              openingFolder={openFolderPendingId === show.id}
            />
          ))
        : null,
    [view, shows, returnState, openDetail, handleRescrape, handleOpenFolder, rescrapePendingId, openFolderPendingId],
  )
  const listRows = useMemo(
    () =>
      view === "list"
        ? shows.map((show, index) => (
            <ShowRow
              key={show.id}
              show={show}
              index={index}
              returnState={returnState}
              openDetail={openDetail}
              onUpload={setUploadId}
              onItems={setItemsShow}
              onRescrape={handleRescrape}
              onOpenFolder={handleOpenFolder}
              rescraping={rescrapePendingId === show.id}
              openingFolder={openFolderPendingId === show.id}
            />
          ))
        : null,
    [view, shows, returnState, openDetail, handleRescrape, handleOpenFolder, rescrapePendingId, openFolderPendingId],
  )
  if (params.has("id")) {
    const legacy = new URLSearchParams(params)
    const id = legacy.get("id")
    legacy.delete("id")
    return (
      <Navigate
        to={`/shows/${encodeURIComponent(id || "invalid")}`}
        replace
        state={{ from: `/shows${legacy.size ? `?${legacy}` : ""}` }}
      />
    )
  }

  if (showsQuery.isPending) return <ShowsLoading query={query} view={view} filtered={params.has("id")} />

  return (
    <div>
      {rescrape.isError && (
        <p role="alert" className="mb-4 text-sm text-danger">
          重新刮削提交失败：{rescrape.error.message}
        </p>
      )}
      <ArtworkUpload
        show={showsQuery.data?.find((show) => show.id === uploadId) ?? null}
        onClose={() => setUploadId(null)}
      />
      <Dialog
        open={itemsShow !== null}
        onOpenChange={(open) => {
          if (!open) setItemsShow(null)
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{itemsShow?.name ?? "RSS 条目"}</DialogTitle>
            <DialogDescription>RSS 中已发现的原始标题，共 {itemsShow?.discovered_items ?? 0} 条。</DialogDescription>
          </DialogHeader>
          {itemTitlesQuery.isPending && (
            <div role="status" className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted">
              <LoaderCircle size={16} className="animate-spin" />
              正在读取标题…
            </div>
          )}
          {itemTitlesQuery.isError && (
            <div role="alert" className="rounded-control bg-danger-soft p-4 text-sm text-danger">
              读取失败：{itemTitlesQuery.error.message}
              <button type="button" className="ml-2 underline" onClick={() => void itemTitlesQuery.refetch()}>
                重试
              </button>
            </div>
          )}
          {itemTitlesQuery.isSuccess && itemTitlesQuery.data.length === 0 && (
            <p className="py-10 text-center text-sm text-muted">暂无 RSS 标题。</p>
          )}
          {itemTitlesQuery.isSuccess && itemTitlesQuery.data.length > 0 && (
            <ul className="max-h-[60vh] divide-y divide-[var(--border-soft)] overflow-y-auto border-y border-border">
              {itemTitlesQuery.data.map((title, index) => (
                <li key={`${index}-${title}`} className="break-words py-3 text-sm leading-6 text-ink">
                  {title}
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
      <ShowsHeader
        query={query}
        view={view}
        filtered={params.has("id")}
        onClear={() => {
          setQuery("")
          setParams(new URLSearchParams())
        }}
        onQueryChange={(value) => {
          setQuery(value)
          const next = new URLSearchParams(params)
          next.delete("id")
          if (value) next.set("q", value)
          else next.delete("q")
          setParams(next, { replace: true })
        }}
        onViewChange={changeView}
      />

      {showsQuery.isError && (
        <Card>
          <CardContent className="p-8 text-center text-sm text-danger">
            读取番剧失败：{showsQuery.error.message}
          </CardContent>
        </Card>
      )}
      {!showsQuery.isError && !shows.length && (
        <Card>
          <CardContent className="grid min-h-56 place-items-center p-8 text-center">
            <div>
              <ImageOff className="mx-auto mb-3 text-muted" />
              <p className="font-medium">还没有匹配的番剧订阅</p>
              <p className="mt-1 text-sm text-muted">点击“添加订阅”并关联 TMDB 条目。</p>
            </div>
          </CardContent>
        </Card>
      )}

      {view === "posters" && shows.length > 0 && (
        <Masonry className="show-poster-grid" columnWidth={250} aria-label="番剧海报">
          {posterTiles}
        </Masonry>
      )}
      {view === "cards" && (
        <Masonry
          className="show-card-grid"
          columns="auto-fit"
          columnWidth={400}
          contentHeight={440}
          aria-label="番剧卡片"
        >
          {cardTiles}
        </Masonry>
      )}
      {view === "list" && shows.length > 0 && (
        <ul className="show-row-list" aria-label="番剧列表">
          {listRows}
        </ul>
      )}
    </div>
  )
}
