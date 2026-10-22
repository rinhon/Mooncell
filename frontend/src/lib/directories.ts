import { queryOptions } from "@tanstack/react-query"
import { api } from "@/lib/api"

export type Directory = { name: string; path: string }
type Listing = { path: string | null; children: Directory[] }

export const directoryQueryKey = ["directories"] as const

export function directoryQueryOptions(path?: string) {
  return queryOptions({
    queryKey: [...directoryQueryKey, path ?? null],
    queryFn: ({ signal }) => api<Listing>(`/filesystem/directories${path ? `?path=${encodeURIComponent(path)}` : ""}`, { signal }),
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  })
}
