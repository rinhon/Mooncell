export const MIKAN_BASE_URL = "https://mikanani.me"

export function mikanSearchUrl(title: string): string {
  return `${MIKAN_BASE_URL}/Home/Search?searchstr=${encodeURIComponent(title)}`
}
