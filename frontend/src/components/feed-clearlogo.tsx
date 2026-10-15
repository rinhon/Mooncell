import { useQuery } from "@tanstack/react-query"
import { api, type Show } from "@/lib/api"

/** 保留 Logo 原色，按透明图案的亮度选择浅色或深色底板。 */
export function FeedClearlogo({ show }: { show: Show }) {
  const version = encodeURIComponent(show.artwork_version ?? "")
  const path = `/shows/${show.id}/artwork/clearlogo`
  const appearance = useQuery({
    queryKey: ["clearlogo-appearance", show.id, show.artwork_version],
    queryFn: () => api<{ background: "light" | "dark" }>(`${path}/appearance?v=${version}`),
    staleTime: Infinity,
    retry: false,
  })
  return <div className="clearlogo-plate" data-background={appearance.data?.background ?? "dark"}>
    <img src={`/api/v1${path}?v=${version}`} alt="" loading="lazy"/>
  </div>
}
