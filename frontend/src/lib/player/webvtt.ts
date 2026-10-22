export interface SubtitleCue {
  start: number
  end: number
  text: string
}

function timestamp(value: string): number | null {
  const match = /^(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})$/.exec(value)
  if (!match) return null
  const hours = Number(match[1] ?? 0)
  const minutes = Number(match[2])
  const seconds = Number(match[3])
  if (minutes >= 60 || seconds >= 60) return null
  return hours * 3600 + minutes * 60 + seconds + Number(match[4]) / 1000
}

function plainText(text: string): string {
  // Keep subtitle text in React's escaped text nodes. VTT styling, voice labels,
  // karaoke timestamps and HTML-like tags never become DOM markup.
  return text.replace(/<[^>]*>/g, "").replace(
    /&(amp|lt|gt|nbsp|lrm|rlm);/g,
    (_entity, name: string) =>
      ({
        amp: "&",
        lt: "<",
        gt: ">",
        nbsp: "\u00a0",
        lrm: "\u200e",
        rlm: "\u200f",
      })[name] ?? _entity,
  )
}

export function parseWebVtt(source: string): SubtitleCue[] {
  const lines = source
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
  if (!/^WEBVTT(?:[ \t].*)?$/.test(lines[0] ?? "")) throw new Error("字幕不是有效的 WebVTT 文件。")
  const cues: SubtitleCue[] = []
  let index = 1
  // Header metadata ends at the first blank line.
  while (index < lines.length && lines[index].trim()) index += 1
  while (index < lines.length) {
    while (index < lines.length && !lines[index].trim()) index += 1
    const block: string[] = []
    while (index < lines.length && lines[index].trim()) block.push(lines[index++])
    if (!block.length || /^(NOTE(?:[ \t]|$)|STYLE$|REGION$)/.test(block[0])) continue
    const timingIndex = block[0].includes("-->") ? 0 : 1
    const timing = /^(\S+)[ \t]+-->[ \t]+(\S+)(?:[ \t].*)?$/.exec(block[timingIndex] ?? "")
    if (!timing) continue
    const start = timestamp(timing[1])
    const end = timestamp(timing[2])
    if (start === null || end === null || end <= start) continue
    const text = plainText(block.slice(timingIndex + 1).join("\n"))
    if (text) cues.push({ start, end, text })
  }
  return cues.sort((left, right) => left.start - right.start)
}
