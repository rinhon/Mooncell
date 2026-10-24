import { useCallback, useEffect, useRef, useState } from "react"

type ImageStatus = "loading" | "loaded" | "error"

const retryDelays = [1000, 3000, 10000]

/** 每个资源单独挂载（key={src}）；重试沿用原 URL，保留浏览器的缓存语义。 */
export function useImageRecovery() {
  const [result, setResult] = useState({ attempt: 0, status: "loading" as ImageStatus, failed: false })
  const lifecycle = useRef({
    ...result,
    active: true,
    retries: 0,
    forwarded: false,
    timer: undefined as number | undefined,
  })

  const retry = useCallback((resetBudget: boolean) => {
    const current = lifecycle.current
    if (!current.active || current.status !== "error" || !navigator.onLine || document.visibilityState === "hidden")
      return
    if (current.timer !== undefined) window.clearTimeout(current.timer)
    current.timer = undefined
    current.retries = resetBudget ? 0 : current.retries + 1
    current.attempt += 1
    current.status = "loading"
    current.forwarded = false
    setResult({ attempt: current.attempt, status: current.status, failed: current.failed })
  }, [])

  useEffect(() => {
    const current = lifecycle.current
    current.active = true
    const recover = () => retry(true)
    window.addEventListener("online", recover)
    document.addEventListener("visibilitychange", recover)
    return () => {
      current.active = false
      if (current.timer !== undefined) window.clearTimeout(current.timer)
      current.timer = undefined
      window.removeEventListener("online", recover)
      document.removeEventListener("visibilitychange", recover)
    }
  }, [retry])

  useEffect(() => {
    const current = lifecycle.current
    if (result.status !== "error" || current.retries >= retryDelays.length) return
    const timer = window.setTimeout(() => {
      if (!current.active || current.attempt !== result.attempt || current.status !== "error") return
      current.timer = undefined
      retry(false)
    }, retryDelays[current.retries])
    current.timer = timer
    return () => {
      window.clearTimeout(timer)
      if (current.timer === timer) current.timer = undefined
    }
  }, [result.status, result.attempt, retry])

  const report = useCallback(
    (status: "loaded" | "error", fromEvent = true) => {
      const current = lifecycle.current
      // 缓存完成检查和 DOM 事件可能同时发生；旧 attempt 也可能迟到。
      if (!current.active || current.attempt !== result.attempt) return false
      if (current.status === "loading") {
        current.status = status
        current.failed = status === "error"
        if (status === "loaded") current.retries = 0
        setResult({ attempt: current.attempt, status, failed: current.failed })
      } else if (current.status !== status) return false
      // ref 只同步缓存命中状态；随后的真实 DOM 事件仍向调用方转发一次。
      if (!fromEvent || current.forwarded) return false
      current.forwarded = true
      return true
    },
    [result.attempt],
  )
  const onLoad = useCallback(() => report("loaded"), [report])
  const onError = useCallback(() => report("error"), [report])
  const ref = useCallback(
    (image: HTMLImageElement | null) => {
      if (image?.complete) {
        report(image.naturalWidth > 0 ? "loaded" : "error", false)
      }
    },
    [report],
  )

  return { ...result, ref, onLoad, onError }
}
