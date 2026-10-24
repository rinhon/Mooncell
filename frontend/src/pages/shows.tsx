import { ArtworkUpload } from "@/components/artwork-upload"
import { ShowsHeader, ShowsLoading, type ShowsView } from "@/components/shows-loading"
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ImageOff, LoaderCircle } from "lucide-react"
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom"
import { api, type Show } from "@/lib/api"
import { showReturnState } from "@/lib/show-artwork"
import { ShowCard } from "@/components/shows/show-card"
import { ShowPosterTile } from "@/components/shows/show-poster-tile"
import { ShowRow } from "@/components/shows/show-row"
import { Card, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useToast } from "@/components/ui/toast"

function useCardColumns() {
  const getColumns = () =>
    window.matchMedia("(min-width: 1280px)").matches ? 3 : window.matchMedia("(min-width: 640px)").matches ? 2 : 1
  const [columns, setColumns] = useState(getColumns)
  useEffect(() => {
    const breakpoints = [window.matchMedia("(min-width: 640px)"), window.matchMedia("(min-width: 1280px)")]
    const update = () => setColumns(getColumns())
    breakpoints.forEach((breakpoint) => breakpoint.addEventListener("change", update))
    update()
    return () => breakpoints.forEach((breakpoint) => breakpoint.removeEventListener("change", update))
  }, [])
  return columns
}

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
  const cardColumns = useCardColumns()
  const location = useLocation()
  const navigate = useNavigate()
  const restore = showReturnState(location.state?.restoreShowList)
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState(() => params.get("q") ?? "")
  const [view, setView] = useState<ShowsView>(() => initialView(location.state?.restoreShowList))
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
    if (!showsQuery.data || restoredScroll.current) return
    // 卡片与图片槽的尺寸由布局决定，数据提交后即可恢复，无需等待图片。
    const frame = window.requestAnimationFrame(() => {
      window.scrollTo({ top: restore.scrollY ?? 0, behavior: "instant" })
      restoredScroll.current = true
    })
    return () => window.cancelAnimationFrame(frame)
  }, [showsQuery.data, restore.scrollY])
  useEffect(() => {
    setQuery(params.get("q") ?? "")
  }, [params])
  const detailState = () => ({
    from: `/shows${query ? `?${new URLSearchParams({ q: query })}` : ""}`,
    view,
    scrollY: window.scrollY,
  })
  function openDetail(event: MouseEvent<HTMLAnchorElement>, id: number) {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    const context = detailState()
    navigate(context.from, { replace: true, state: { restoreShowList: context } })
    navigate(`/shows/${id}`, { state: context })
  }
  const displayProps = (show: Show, index: number) => ({
    show,
    index,
    columns: cardColumns,
    detailState,
    openDetail,
    onUpload: setUploadId,
    onItems: setItemsShow,
    onRescrape: (id: number) => rescrape.mutate(id),
    onOpenFolder: (id: number) => openFolder.mutate(id),
    rescraping: rescrape.isPending && rescrape.variables === show.id,
    openingFolder: openFolder.isPending && openFolder.variables === show.id,
  })
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
        <div className="show-poster-grid" aria-label="番剧海报">
          {shows.map((show, index) => (
            <ShowPosterTile key={show.id} {...displayProps(show, index)} />
          ))}
        </div>
      )}
      {view === "cards" && (
        <div className="show-card-grid" aria-label="番剧卡片">
          {shows.map((show, index) => (
            <ShowCard key={show.id} {...displayProps(show, index)} />
          ))}
        </div>
      )}
      {view === "list" && shows.length > 0 && (
        <ul className="show-row-list" aria-label="番剧列表">
          {shows.map((show, index) => (
            <ShowRow key={show.id} {...displayProps(show, index)} />
          ))}
        </ul>
      )}
    </div>
  )
}
