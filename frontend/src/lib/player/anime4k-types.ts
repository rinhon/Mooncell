export type Anime4kMode = "off" | "light" | "standard"

export type Anime4kStatus = "off" | "initializing" | "ready" | "unavailable" | "failed" | "destroyed"

export interface Anime4kState {
  requestedMode: Anime4kMode
  effectiveMode: Anime4kMode
  status: Anime4kStatus
  reason?: string
}

export interface Anime4kMetrics {
  /** Submission through queue completion, including browser/driver overhead; not GPU timestamp time. */
  submissionLatencyMs: number
  frameBudgetMs: number
  mode: Exclude<Anime4kMode, "off">
  outputWidth: number
  outputHeight: number
}

export interface Anime4kRendererOptions {
  /** The existing media element remains the sole audio and playback clock owner. */
  video: HTMLVideoElement
  canvas: HTMLCanvasElement
  container: HTMLElement
  maxDpr?: number
  maxOutputPixels?: number
  /** Limit the x2 model's intermediate output as well as the final canvas. */
  maxProcessingPixels?: number
  onStateChange?: (state: Anime4kState) => void
  onNotice?: (message: string) => void
  onMetrics?: (metrics: Anime4kMetrics) => void
}

export interface Anime4kRenderer {
  setMode(mode: Anime4kMode): Promise<void>
  renderCurrentFrame(): void
  getState(): Anime4kState
  destroy(): void
}
