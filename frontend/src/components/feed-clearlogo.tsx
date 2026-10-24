import type { ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { ImageOff } from "lucide-react"
import { api, type Show } from "@/lib/api"
import { artworkUrl, artworkVersion } from "@/lib/show-artwork"
import { FadeInImage } from "@/components/ui/fade-in-image"

/** 保留 Logo 原色，按透明图案的亮度选择浅色或深色底板。 */
export function FeedClearlogo({ show, fallback, onError }: { show: Show; fallback?: ReactNode; onError?: () => void }) {
  const version = artworkVersion(show, "clearlogo")
  const path = `/shows/${show.id}/artwork/clearlogo`
  const appearance = useQuery({
    queryKey: ["clearlogo-appearance", show.id, version],
    queryFn: () => api<{ background: "light" | "dark" }>(`${path}/appearance?v=${encodeURIComponent(version)}`),
    staleTime: Infinity,
    retry: 2,
  })
  return (
    <div className="clearlogo-plate" data-background={appearance.data?.background ?? "dark"}>
      <FadeInImage
        src={artworkUrl(show, "clearlogo")}
        alt=""
        loading="lazy"
        fallback={fallback ?? <ImageOff size={18} className="text-muted" aria-label="Logo 暂不可用" />}
        onError={onError}
        onLoad={() => {
          if (appearance.isError) void appearance.refetch()
        }}
      />
    </div>
  )
}
