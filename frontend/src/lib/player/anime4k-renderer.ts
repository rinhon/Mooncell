/// <reference types="@webgpu/types" />

import type { Anime4KPipeline } from "anime4k-webgpu"
import type { Anime4kMode, Anime4kRenderer, Anime4kRendererOptions, Anime4kState } from "./anime4k-types"

export type { Anime4kMode, Anime4kRenderer, Anime4kRendererOptions, Anime4kState } from "./anime4k-types"

// Each instance owns its GPUDevice. The upstream pipeline API exposes no destroy(),
// so destroying that device is the public API that releases all hidden resources.
interface Resources {
  device: GPUDevice
  context: GPUCanvasContext
  input: GPUTexture
  model: Anime4KPipeline
  presentation: GPURenderPipeline
  bindGroup: GPUBindGroup
  width: number
  height: number
  mode: Exclude<Anime4kMode, "off">
  removeErrorListener?: () => void
}

const PRESENT_SHADER = /* wgsl */ `
struct Vertex { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> Vertex {
  let positions = array(vec2f(-1., -1.), vec2f(3., -1.), vec2f(-1., 3.));
  let position = positions[index];
  return Vertex(vec4f(position, 0., 1.), vec2f((position.x + 1.) * .5, (1. - position.y) * .5));
}
@group(0) @binding(0) var image: texture_2d<f32>;
@group(0) @binding(1) var imageSampler: sampler;
@fragment fn fragmentMain(input: Vertex) -> @location(0) vec4f {
  return textureSample(image, imageSampler, input.uv);
}
`

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createAnime4kRenderer(options: Anime4kRendererOptions): Anime4kRenderer {
  const { video, canvas, container } = options
  const maxDpr = Math.min(2, positive(options.maxDpr, 1.5))
  const maxOutputPixels = positive(options.maxOutputPixels, 3840 * 2160)
  const maxProcessingPixels = positive(options.maxProcessingPixels, 3840 * 2160)
  let state: Anime4kState = { requestedMode: "off", effectiveMode: "off", status: "off" }
  let resources: Resources | undefined
  let epoch = 0
  let destroyed = false
  let videoCallback: number | undefined
  let animationCallback: number | undefined
  let drawing = false
  let redrawPending = false
  let slowFrames = 0
  let frameBudgetMs = 1000 / 30
  let previousFrame: VideoFrameCallbackMetadata | undefined
  let noticeSent = false
  let recoveryAttempted = false
  let targetMode: Anime4kMode = "off"
  const cleanup: (() => void)[] = []

  function publish(next: Anime4kState) {
    state = next
    options.onStateChange?.({ ...state })
  }

  function cancelCallbacks() {
    if (videoCallback !== undefined) video.cancelVideoFrameCallback(videoCallback)
    if (animationCallback !== undefined) cancelAnimationFrame(animationCallback)
    videoCallback = undefined
    animationCallback = undefined
  }

  function release() {
    cancelCallbacks()
    const previous = resources
    resources = undefined
    drawing = false
    redrawPending = false
    previousFrame = undefined
    if (previous) {
      previous.removeErrorListener?.()
      previous.context.unconfigure()
      previous.input.destroy()
      previous.device.destroy()
    }
  }

  function disable(reason: string, status: "unavailable" | "failed" = "failed") {
    if (destroyed) return
    epoch += 1
    targetMode = "off"
    release()
    publish({ requestedMode: state.requestedMode, effectiveMode: "off", status, reason })
  }

  function notice(message: string) {
    if (noticeSent) return
    noticeSent = true
    options.onNotice?.(message)
  }

  function resizeOutput(active: Resources) {
    const bounds = container.getBoundingClientRect()
    const dpr = Math.min(maxDpr, positive(window.devicePixelRatio, 1))
    // Fit inside the complete player, including fullscreen, without stretching.
    const scale = Math.min(
      (Math.max(1, bounds.width) * dpr) / active.width,
      (Math.max(1, bounds.height) * dpr) / active.height,
      Math.sqrt(maxOutputPixels / (active.width * active.height)),
      active.device.limits.maxTextureDimension2D / active.width,
      active.device.limits.maxTextureDimension2D / active.height,
      2,
    )
    const width = Math.max(1, Math.floor(active.width * scale))
    const height = Math.max(1, Math.floor(active.height * scale))
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
  }

  function scheduleVideoFrame() {
    if (destroyed || !resources || video.paused || video.ended || document.hidden || videoCallback !== undefined) return
    videoCallback = video.requestVideoFrameCallback((_now, metadata) => {
      videoCallback = undefined
      if (previousFrame) {
        const frames = metadata.presentedFrames - previousFrame.presentedFrames
        const mediaDelta = metadata.mediaTime - previousFrame.mediaTime
        if (frames > 0 && mediaDelta > 0 && mediaDelta < 1) {
          frameBudgetMs = Math.min(100, Math.max(8, (mediaDelta * 1000) / frames / Math.max(0.1, video.playbackRate)))
        }
      }
      previousFrame = metadata
      draw()
    })
  }

  function draw() {
    const active = resources
    if (destroyed || !active || document.hidden || video.readyState < video.HAVE_CURRENT_DATA || video.seeking) {
      scheduleVideoFrame()
      return
    }
    if (video.videoWidth !== active.width || video.videoHeight !== active.height) {
      void rebuild(targetMode)
      return
    }
    if (drawing) {
      redrawPending = true
      return
    }
    const drawEpoch = epoch
    const started = performance.now()
    drawing = true
    try {
      resizeOutput(active)
      active.device.queue.copyExternalImageToTexture({ source: video }, { texture: active.input }, [
        active.width,
        active.height,
      ])
      const encoder = active.device.createCommandEncoder({ label: "Mooncell Anime4K frame" })
      active.model.pass(encoder)
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: active.context.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      })
      pass.setPipeline(active.presentation)
      pass.setBindGroup(0, active.bindGroup)
      pass.draw(3)
      pass.end()
      active.device.queue.submit([encoder.finish()])
      // At most one submission is in flight. This prevents a slow GPU accumulating
      // work while video/audio and the HLS media clock continue independently.
      void active.device.queue.onSubmittedWorkDone().then(
        () => {
          if (destroyed || drawEpoch !== epoch || active !== resources) return
          drawing = false
          const elapsed = performance.now() - started
          if (state.effectiveMode !== active.mode || state.status !== "ready") {
            publish({ requestedMode: state.requestedMode, effectiveMode: active.mode, status: "ready" })
          }
          options.onMetrics?.({
            submissionLatencyMs: elapsed,
            frameBudgetMs,
            mode: active.mode,
            outputWidth: canvas.width,
            outputHeight: canvas.height,
          })
          if (!video.paused && !document.hidden) {
            slowFrames = elapsed > frameBudgetMs * 1.15 ? slowFrames + 1 : Math.max(0, slowFrames - 2)
            if (slowFrames >= 24) {
              slowFrames = 0
              notice("画面增强持续超出帧预算，已自动降低增强档位。")
              if (active.mode === "standard") void rebuild("light")
              else disable("当前设备无法稳定处理轻量增强，已恢复普通播放。", "unavailable")
              return
            }
          }
          if (redrawPending) {
            redrawPending = false
            renderCurrentFrame()
          } else {
            scheduleVideoFrame()
          }
        },
        (error: unknown) => {
          if (drawEpoch === epoch && !destroyed) disable(`增强渲染失败：${errorMessage(error)}`)
        },
      )
    } catch (error) {
      if (drawEpoch === epoch) disable(`增强渲染失败：${errorMessage(error)}`)
    }
  }

  function renderCurrentFrame() {
    if (destroyed || !resources || animationCallback !== undefined) return
    animationCallback = requestAnimationFrame(() => {
      animationCallback = undefined
      draw()
    })
  }

  async function rebuild(mode: Anime4kMode): Promise<void> {
    const buildEpoch = ++epoch
    targetMode = mode
    release()
    slowFrames = 0
    if (destroyed) return
    if (mode === "off") {
      publish({ requestedMode: state.requestedMode, effectiveMode: "off", status: "off" })
      return
    }
    if (!window.isSecureContext) {
      disable("画面增强需要 HTTPS 或本机 localhost 安全上下文。", "unavailable")
      return
    }
    if (!navigator.gpu || typeof video.requestVideoFrameCallback !== "function") {
      disable("此浏览器不支持 WebGPU 或视频帧回调，已保留普通播放。", "unavailable")
      return
    }
    publish({ requestedMode: state.requestedMode, effectiveMode: "off", status: "initializing" })
    // loadeddata/resize will retry once the same video has a decoded frame.
    if (!video.videoWidth || !video.videoHeight || video.readyState < video.HAVE_CURRENT_DATA) return
    if (video.videoWidth * video.videoHeight * 4 > maxProcessingPixels) {
      disable("源视频超过当前增强处理像素上限，已保留普通播放。", "unavailable")
      return
    }
    let device: GPUDevice | undefined
    let ownedContext: GPUCanvasContext | undefined
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })
      if (destroyed || buildEpoch !== epoch) return
      if (!adapter) {
        disable("未找到可用的 WebGPU 适配器，已保留普通播放。", "unavailable")
        return
      }
      device = await adapter.requestDevice()
      if (destroyed || buildEpoch !== epoch) {
        device.destroy()
        return
      }
      const { CNNx2M, CNNx2VL } = await import("anime4k-webgpu")
      if (destroyed || buildEpoch !== epoch) {
        device.destroy()
        return
      }
      const width = video.videoWidth
      const height = video.videoHeight
      if (
        !width ||
        !height ||
        width * height * 4 > maxProcessingPixels ||
        Math.max(width, height) * 2 > device.limits.maxTextureDimension2D
      ) {
        device.destroy()
        disable("视频尺寸超过当前 GPU 增强上限，已保留普通播放。", "unavailable")
        return
      }
      const context = canvas.getContext("webgpu")
      if (!context) throw new Error("无法创建 WebGPU Canvas")
      ownedContext = context
      const format = navigator.gpu.getPreferredCanvasFormat()
      device.pushErrorScope("validation")
      context.configure({ device, format, alphaMode: "opaque" })
      const input = device.createTexture({
        label: "Mooncell video frame",
        size: [width, height],
        format: "rgba16float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      })
      const model =
        mode === "light" ? new CNNx2M({ device, inputTexture: input }) : new CNNx2VL({ device, inputTexture: input })
      const module = device.createShaderModule({ label: "Mooncell Anime4K presentation", code: PRESENT_SHADER })
      const presentation = device.createRenderPipeline({
        layout: "auto",
        vertex: { module, entryPoint: "vertexMain" },
        fragment: { module, entryPoint: "fragmentMain", targets: [{ format }] },
        primitive: { topology: "triangle-list" },
      })
      const bindGroup = device.createBindGroup({
        layout: presentation.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: model.getOutputTexture().createView() },
          { binding: 1, resource: device.createSampler({ magFilter: "linear", minFilter: "linear" }) },
        ],
      })
      const validationError = await device.popErrorScope()
      if (destroyed || buildEpoch !== epoch) {
        // A newer build may already own this canvas context. Never unconfigure it.
        device.destroy()
        return
      }
      if (validationError) throw new Error(validationError.message)
      resources = { device, context, input, model, presentation, bindGroup, width, height, mode }
      const activeDevice = device
      const onGpuError = (event: GPUUncapturedErrorEvent) => {
        event.preventDefault()
        if (resources?.device === activeDevice) disable(`GPU 增强错误：${event.error.message}`)
      }
      device.addEventListener("uncapturederror", onGpuError)
      // Removing the device listener also drops closures held until device GC.
      resources.removeErrorListener = () => activeDevice.removeEventListener("uncapturederror", onGpuError)
      void device.lost.then((info) => {
        if (destroyed || buildEpoch !== epoch || resources?.device !== activeDevice) return
        if (info.reason !== "destroyed" && !recoveryAttempted) {
          recoveryAttempted = true
          notice("GPU 设备连接中断，正在重新建立画面增强。")
          void rebuild(mode)
        } else {
          disable("GPU 设备不可用，已恢复普通播放。", "unavailable")
        }
      })
      renderCurrentFrame()
      scheduleVideoFrame()
    } catch (error) {
      if (buildEpoch !== epoch || destroyed) {
        device?.destroy()
        return
      }
      if (!resources) {
        ownedContext?.unconfigure()
        device?.destroy()
      }
      disable(`无法启用画面增强：${errorMessage(error)}`, "unavailable")
    }
  }

  function onReady() {
    if (targetMode === "off" || destroyed) return
    if (!resources && state.status === "initializing") void rebuild(targetMode)
    else renderCurrentFrame()
  }

  function onVideoResize() {
    if (targetMode === "off" || destroyed) return
    if (!resources || resources.width !== video.videoWidth || resources.height !== video.videoHeight) {
      void rebuild(targetMode)
    }
  }

  function listen(target: EventTarget, event: string, callback: EventListener) {
    target.addEventListener(event, callback)
    cleanup.push(() => target.removeEventListener(event, callback))
  }
  listen(video, "loadeddata", onReady)
  listen(video, "seeked", renderCurrentFrame)
  listen(video, "resize", onVideoResize)
  listen(video, "play", scheduleVideoFrame)
  listen(video, "pause", () => {
    cancelCallbacks()
    renderCurrentFrame()
  })
  listen(video, "emptied", () => {
    epoch += 1
    release()
    targetMode = state.requestedMode
    if (state.requestedMode !== "off")
      publish({ requestedMode: state.requestedMode, effectiveMode: "off", status: "initializing" })
  })
  listen(video, "timeupdate", () => {
    if (video.paused) renderCurrentFrame()
  })
  listen(document, "visibilitychange", () => {
    if (document.hidden) cancelCallbacks()
    else {
      renderCurrentFrame()
      scheduleVideoFrame()
    }
  })
  listen(document, "fullscreenchange", renderCurrentFrame)
  listen(window, "resize", renderCurrentFrame)
  const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(renderCurrentFrame)
  observer?.observe(container)
  cleanup.push(() => observer?.disconnect())

  return {
    async setMode(mode) {
      if (destroyed) return
      noticeSent = false
      recoveryAttempted = false
      state = { ...state, requestedMode: mode }
      await rebuild(mode)
    },
    renderCurrentFrame,
    getState: () => ({ ...state }),
    destroy() {
      if (destroyed) return
      destroyed = true
      epoch += 1
      release()
      cleanup.splice(0).forEach((dispose) => dispose())
      publish({ requestedMode: "off", effectiveMode: "off", status: "destroyed" })
    },
  }
}
