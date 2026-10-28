import type { ReactNode } from "react"
import { AddSubscriptionButton } from "@/components/add-subscription-button"
import { PageHeading } from "@/components/page-heading"
import { CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Masonry } from "@/components/ui/masonry"
import { Skeleton } from "@/components/ui/skeleton"
import "@/pages/feeds.css"

export function FeedsHeading({ action }: { action: ReactNode }) {
  return (
    <PageHeading
      eyebrow="Sources"
      title="订阅与合集"
      description="管理 RSS 发布源，或通过单个磁力下载合集，匹配 TMDB 并整理媒体库。"
      action={action}
    />
  )
}

export function FeedsSection({ count, children }: { count?: number; children: ReactNode }) {
  return (
    <section aria-label="全部订阅">
      <CardHeader className="mb-5 border-0 p-0">
        <div>
          <CardTitle>全部订阅</CardTitle>
          {count === undefined ? (
            <Skeleton className="mt-1 h-6 w-24" />
          ) : (
            <CardDescription>{count} 个发布源</CardDescription>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">{children}</CardContent>
    </section>
  )
}

export function FeedsLoading({ count }: { count?: number }) {
  return (
    <>
      <FeedsHeading action={<AddSubscriptionButton disabled />} />
      <FeedsSection count={count}>
        <div role="status" aria-label="正在加载订阅与合集" aria-busy="true">
          <span className="sr-only">正在读取订阅与合集…</span>
          <div aria-hidden="true">
            <Masonry className="feed-list" columns="auto-fit" columnWidth={400} animate={false}>
              {Array.from({ length: count ?? 6 }, (_, index) => (
                <div key={index} className="feed-card flex flex-col">
                  <div className="feed-card-title">
                    <Skeleton className={`h-5 ${index % 2 ? "w-1/2" : "w-3/4"}`} />
                  </div>
                  <div className="feed-card-clearlogo">
                    <Skeleton className="h-full w-full" />
                  </div>
                  <div className="feed-card-status">
                    <div className="feed-card-labels">
                      <Skeleton className="h-7 w-14" />
                      <Skeleton className="h-7 w-20" />
                    </div>
                    <div className="feed-card-actions">
                      <Skeleton className="size-9" />
                      <Skeleton className="size-9" />
                      <Skeleton className="size-9" />
                    </div>
                  </div>
                </div>
              ))}
            </Masonry>
          </div>
        </div>
      </FeedsSection>
    </>
  )
}
