import type { PlaybackSession, SeekPath } from "./types"

export interface PlaybackEngine {
  update(session: PlaybackSession): void
  getSourceTime(mediaTime?: number): number
  seek(position: number): SeekPath
  alignToSource(position: number): boolean
  getBufferedAhead(): number
  destroy(): void
}

export function bufferedAhead(video: HTMLVideoElement) {
  for (let index = 0; index < video.buffered.length; index++) {
    if (video.currentTime >= video.buffered.start(index) && video.currentTime < video.buffered.end(index))
      return video.buffered.end(index) - video.currentTime
  }
  return 0
}
