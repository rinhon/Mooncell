import type { PlaybackInfo } from "./types"

type SubtitleTrack = PlaybackInfo["subtitle_tracks"][number]

function scriptPreference(value: string) {
  if (
    /简(?:体|中|英|日|繁)|簡(?:體|中|英|日|繁)|^(?:简|簡)$|simplified/.test(value) ||
    /(?:^|[^a-z0-9])(?:chs|sc|hans|gb2312|gb)(?=$|[^a-z0-9])/.test(value) ||
    /(?:^|[^a-z0-9])(?:zh|zho|chi|cmn)-(?:cn|sg)(?=$|[^a-z0-9])/.test(value)
  )
    return 0
  if (
    /繁(?:体|體|中|英|日)|^繁$|traditional/.test(value) ||
    /(?:^|[^a-z0-9])(?:cht|tc|hant|big5)(?=$|[^a-z0-9])/.test(value) ||
    /(?:^|[^a-z0-9])(?:zh|zho|chi|cmn)-(?:tw|hk|mo)(?=$|[^a-z0-9])/.test(value)
  )
    return 1
  return null
}

function chinesePreference(track: SubtitleTrack) {
  const language = (track.language ?? "").normalize("NFKC").trim().toLowerCase().replaceAll("_", "-")
  const title = (track.title ?? "").normalize("NFKC").toLowerCase().replaceAll("_", "-")
  const script = scriptPreference(language) ?? scriptPreference(title)
  if (script !== null) return script
  if (
    /(?:^|[^a-z0-9])(?:zh|zho|chi|cmn|yue)(?=$|[^a-z0-9])/.test(`${language} ${title}`) ||
    /中文|汉语|漢語|chinese|mandarin|cantonese/.test(`${language} ${title}`)
  )
    return 2
  return null
}

/** 每次打开视频时优先简中，再选其他可播放的中文字幕。 */
export function preferredChineseSubtitle(tracks: readonly SubtitleTrack[]) {
  let selected = ""
  let preference = Infinity
  for (const track of tracks) {
    if (!track.supported || !track.url) continue
    const rank = chinesePreference(track)
    if (rank !== null && rank < preference) {
      selected = track.id
      preference = rank
    }
  }
  return selected
}
