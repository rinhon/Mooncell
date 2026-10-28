import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { useQueryClient } from "@tanstack/react-query"

const PageReadyContext = createContext<{ ready: boolean; reload: (fallback?: ReactNode) => void }>({
  ready: true,
  reload: () => {},
})
const loadingSelector = '[role="status"][aria-busy="true"]'

export const usePageReady = () => useContext(PageReadyContext).ready

/** 显式切换内容开启新周期，可在首次挂载时设置骨架；轮询和乐观更新不重新遮挡页面。 */
export function usePageLoadCycle(key: string, fallback?: ReactNode, initializeFallback = false) {
  const { reload } = useContext(PageReadyContext)
  const previous = useRef<string | null>(initializeFallback ? null : key)
  useLayoutEffect(() => {
    if (previous.current === key) return
    previous.current = key
    reload(fallback)
  }, [key, reload, fallback])
}

/** 隐藏挂载内容，让依赖查询和屏外图片先完成；显示后不受后台刷新影响。 */
export function PageLoadBoundary({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const client = useQueryClient()
  const contentRef = useRef<HTMLDivElement>(null)
  const focusRef = useRef<HTMLElement | null>(null)
  const [ready, setReady] = useState(false)
  const [cycle, setCycle] = useState(0)
  const [cycleFallback, setCycleFallback] = useState<ReactNode>()
  const reload = useCallback((nextFallback?: ReactNode) => {
    const active = document.activeElement
    if (active instanceof HTMLElement && contentRef.current?.contains(active)) focusRef.current = active
    setCycleFallback(nextFallback)
    setReady(false)
    setCycle((value) => value + 1)
  }, [])

  useLayoutEffect(() => {
    const content = contentRef.current
    if (!content) return
    let stopped = false
    let frame = 0
    const decoded = new WeakMap<HTMLImageElement, { src: string; ready: boolean }>()

    const schedule = () => {
      if (stopped) return
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(check)
    }
    const imageReady = (image: HTMLImageElement) => {
      // 内容尚不可见，lazy 图片也必须主动加载，包含屏外海报和缩略图。
      if (image.loading !== "eager") image.loading = "eager"
      if (!image.complete) return false
      // 加载失败交由现有图片组件呈现占位、继续后台重试，不无限阻塞页面。
      if (image.naturalWidth === 0) return true
      const src = image.currentSrc || image.src
      const previous = decoded.get(image)
      if (previous?.src === src) return previous.ready
      const result = { src, ready: false }
      decoded.set(image, result)
      void image
        .decode()
        .catch(() => {})
        .then(() => {
          result.ready = true
          schedule()
        })
      return false
    }
    const complete = () => {
      let imagesReady = true
      for (const image of content.querySelectorAll("img")) {
        if (!imageReady(image)) imagesReady = false
      }
      const pendingData = client
        .getQueryCache()
        .findAll()
        .some((query) => query.isActive() && query.state.data === undefined && query.state.status === "pending")
      return imagesReady && !pendingData && !content.querySelector(loadingSelector)
    }
    const cleanup = () => {
      stopped = true
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      unsubscribe()
      content.removeEventListener("load", schedule, true)
      content.removeEventListener("error", schedule, true)
    }
    function check() {
      if (stopped || !complete()) return
      // 连续两帧稳定，确保查询的后续组件、失败图片的替代内容都已提交。
      frame = window.requestAnimationFrame(() => {
        if (stopped || !complete()) return
        cleanup()
        setReady(true)
      })
    }

    const observer = new MutationObserver(schedule)
    observer.observe(content, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "srcset", "aria-busy"],
    })
    const unsubscribe = client.getQueryCache().subscribe(schedule)
    content.addEventListener("load", schedule, true)
    content.addEventListener("error", schedule, true)
    schedule()
    return cleanup
  }, [client, cycle])

  useLayoutEffect(() => {
    const content = contentRef.current
    if (!ready || !content) return
    const previousFocus = focusRef.current
    focusRef.current = null
    // 等可见样式生效后再恢复焦点，并在真正聚焦时重新确认当前标签。
    let focusFrame = 0
    const restoreFocus = () => {
      if (
        !previousFocus?.isConnected ||
        (document.activeElement !== document.body && document.activeElement !== previousFocus)
      )
        return
      // Tabs 在 mousedown 时已切换内容，恢复旧标签焦点会自动选回旧日期。
      const focus =
        previousFocus.getAttribute("role") === "tab" && previousFocus.getAttribute("aria-selected") !== "true"
          ? previousFocus.closest('[role="tablist"]')?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
          : previousFocus
      if (!focus || focus.closest("[hidden], [inert]")) return
      if (window.getComputedStyle(focus).visibility === "hidden") {
        focusFrame = window.requestAnimationFrame(restoreFocus)
        return
      }
      focus.focus({ preventScroll: true })
    }
    focusFrame = window.requestAnimationFrame(restoreFocus)
    // 失败后重试等场景也可能再次产生页面骨架，仍需等待随后挂载的图片。
    const observer = new MutationObserver(() => {
      if (content.querySelector(loadingSelector)) reload()
    })
    observer.observe(content, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-busy"],
    })
    return () => {
      window.cancelAnimationFrame(focusFrame)
      observer.disconnect()
    }
  }, [ready, reload])

  return (
    <div className="page-load-boundary" data-ready={ready} aria-busy={!ready}>
      {!ready && <div className="page-load-fallback">{cycleFallback ?? fallback}</div>}
      <div
        ref={contentRef}
        className="page-load-content"
        aria-hidden={!ready || undefined}
        inert={!ready || undefined}
        style={ready ? undefined : { height: 0, overflow: "hidden", visibility: "hidden" }}
      >
        <PageReadyContext.Provider value={{ ready, reload }}>{children}</PageReadyContext.Provider>
      </div>
    </div>
  )
}
