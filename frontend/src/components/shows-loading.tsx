import { GalleryVerticalEnd, Grid2X2, List, Search } from "lucide-react"
import { useSearchParams } from "react-router-dom"
import { AddSubscriptionButton } from "@/components/add-subscription-button"
import { AddSubscriptionDialog } from "@/components/feeds/add-subscription-dialog"
import { PageHeading } from "@/components/page-heading"
import RubberSegment, { type RubberSegmentItem } from "@/components/rubber-segment"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"

import type { ShowsView } from "@/lib/show-artwork"
export type { ShowsView } from "@/lib/show-artwork"
const viewOptions: RubberSegmentItem[] = [
  { value: "cards", label: <span className="sr-only">卡片视图</span>, icon: <Grid2X2 size={15} aria-hidden="true" /> },
  {
    value: "posters",
    label: <span className="sr-only">海报视图</span>,
    icon: <GalleryVerticalEnd size={15} aria-hidden="true" />,
  },
  { value: "list", label: <span className="sr-only">列表视图</span>, icon: <List size={15} aria-hidden="true" /> },
]

export function ShowsHeader({
  query = "",
  view = "cards",
  filtered = false,
  loading = false,
  onQueryChange,
  onViewChange,
  onClear,
}: {
  query?: string
  view?: ShowsView
  filtered?: boolean
  loading?: boolean
  onQueryChange?: (value: string) => void
  onViewChange?: (value: ShowsView) => void
  onClear?: () => void
}) {
  return (
    <>
      <PageHeading
        eyebrow="Subscriptions"
        title="番剧订阅"
        description="订阅数据来自数据库；海报、背景图和透明 Logo 保存在对应番剧目录。"
        action={loading ? <AddSubscriptionButton disabled /> : <AddSubscriptionDialog />}
      />
      <div
        className={[
          "mb-6 flex items-center gap-3 rounded-panel border border-island-border bg-island-background p-3",
          "shadow-[var(--island-shadow)]",
        ].join(" ")}
      >
        {filtered && (
          <Button variant="secondary" size="sm" disabled={loading} onClick={onClear}>
            全部番剧
          </Button>
        )}
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" size={16} />
          <Input
            value={query}
            onChange={(event) => onQueryChange?.(event.target.value)}
            disabled={loading}
            placeholder="搜索订阅名称或 TMDB 名称"
            className="pl-9"
          />
        </div>
        <RubberSegment
          items={viewOptions}
          value={view}
          disabled={loading}
          onChange={(next) => {
            if (next === "cards" || next === "posters" || next === "list") onViewChange?.(next)
          }}
          aria-label="切换番剧视图"
          radius={8}
          size="md"
          trackColor="var(--surface)"
          thumbColor="var(--accent)"
          textColor="var(--ink)"
          activeTextColor="var(--on-accent)"
          className="shrink-0 ring-1 ring-border-soft"
        />
      </div>
    </>
  )
}

function ShowCardSkeleton() {
  return (
    <Card className="flex h-full min-w-0 flex-col overflow-hidden rounded-panel border-island-border bg-island-background">
      <div className="relative h-56 overflow-hidden bg-[var(--skeleton)]">
        <Skeleton className="absolute inset-0 size-full" />
        <div className="absolute inset-x-4 bottom-4 flex items-end gap-4">
          <Skeleton className="h-32 w-22 shrink-0 ring-1 ring-white/30" />
          <div className="min-w-0 flex-1 pb-1">
            <Skeleton className="mb-3 h-10 w-3/4" />
            <Skeleton className="h-6 w-full" />
            <Skeleton className="mt-1 h-4 w-2/3" />
          </div>
        </div>
      </div>
      <CardContent className="flex flex-1 flex-col p-5">
        <div className="flex items-center gap-2">
          <Skeleton className="h-6 w-28" />
          <Skeleton className="h-4 w-10" />
          <Skeleton className="ml-auto size-8" />
        </div>
        <div className="mt-4 grid h-18 content-start gap-2">
          {["w-full", "w-full", "w-3/4"].map((width, index) => (
            <Skeleton key={index} className={`h-4 ${width}`} />
          ))}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 rounded-control border border-border-soft bg-surface/35 p-3">
          {[0, 1].map((index) => (
            <div key={index}>
              <Skeleton className="h-4 w-16" />
              <Skeleton className="mt-1 h-4 w-10" />
            </div>
          ))}
        </div>
        <Skeleton className="mt-4 h-10 w-full" />
      </CardContent>
    </Card>
  )
}

function ShowsListSkeleton({ count }: { count: number }) {
  return (
    <div className="show-row-list">
      {Array.from({ length: count }, (_, index) => (
        <Card key={index} className="show-row-card">
          <Skeleton className="show-row-poster" />
          <div className="min-w-0">
            <Skeleton className="h-5 w-56 max-w-full" />
            <Skeleton className="mt-1 h-4 w-36 max-w-full" />
            <div className="mt-3 flex flex-wrap gap-3">
              <Skeleton className="h-6 w-24" />
              <Skeleton className="h-6 w-20" />
            </div>
          </div>
          <div className="show-row-footer">
            <div className="show-row-discovered">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="mt-2 h-5 w-10" />
            </div>
            <div className="show-row-actions">
              <Skeleton className="h-8 w-24" />
              <Skeleton className="size-10" />
            </div>
          </div>
        </Card>
      ))}
    </div>
  )
}

/** The same layout covers route, database and artwork loading. */
export function ShowsLoading({
  query,
  view = "cards",
  filtered,
  count = 6,
}: {
  query?: string
  view?: ShowsView
  filtered?: boolean
  count?: number
}) {
  const [params] = useSearchParams()
  return (
    <>
      <ShowsHeader query={query ?? params.get("q") ?? ""} view={view} filtered={filtered ?? params.has("id")} loading />
      <div role="status" aria-label="正在加载番剧订阅" aria-busy="true">
        <span className="sr-only">正在加载番剧数据和图片…</span>
        <div aria-hidden="true">
          {view === "list" ? (
            <ShowsListSkeleton count={count} />
          ) : view === "posters" ? (
            <div className="show-poster-grid">
              {Array.from({ length: count }, (_, index) => (
                <Skeleton key={index} className="show-poster-tile" />
              ))}
            </div>
          ) : (
            <div className="show-card-grid">
              {Array.from({ length: count }, (_, index) => (
                <ShowCardSkeleton key={index} />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}
