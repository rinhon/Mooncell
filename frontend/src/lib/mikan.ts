export const MIKAN_BASE_URL = "https://mikan.tangbai.cc"

export function mikanSearchUrl(title: string): string {
  return `${MIKAN_BASE_URL}/Home/Search?searchstr=${encodeURIComponent(title)}`
}
