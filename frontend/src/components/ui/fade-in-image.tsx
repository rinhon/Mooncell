import { useCallback, useState, type ReactNode } from "react"
import { motion, useReducedMotion, type HTMLMotionProps } from "motion/react"
import { spring } from "@/lib/motion"
import { cn } from "@/lib/utils"
import "./fade-in-image.css"

type FadeInImageProps = Omit<HTMLMotionProps<"img">, "src"> & {
  src: string
  placeholder?: ReactNode
  fallback?: ReactNode
}

/** 固定尺寸的父容器负责布局；缓存命中、单图加载和失败占位均不阻塞其他内容。 */
export function FadeInImage({
  src,
  className,
  onLoad,
  onError,
  placeholder,
  fallback = null,
  alt = "",
  decoding = "async",
  ...props
}: FadeInImageProps) {
  const [result, setResult] = useState<{ src: string; status: "loaded" | "error" }>()
  const reducedMotion = useReducedMotion()
  const imageRef = useCallback(
    (image: HTMLImageElement | null) => {
      if (image?.complete) setResult({ src, status: image.naturalWidth > 0 ? "loaded" : "error" })
    },
    [src],
  )
  const status = result?.src === src ? result.status : "loading"

  return (
    <>
      {status === "loading" && placeholder}
      {status === "error" ? (
        fallback
      ) : (
        <motion.img
          {...props}
          key={src}
          ref={imageRef}
          src={src}
          alt={alt}
          decoding={decoding}
          initial={false}
          animate={{ opacity: status === "loaded" ? 1 : 0 }}
          transition={reducedMotion ? { duration: 0 } : spring.gentle}
          className={cn("fade-in-image", className)}
          data-loaded={status === "loaded" || undefined}
          onLoad={(event) => {
            setResult({ src, status: "loaded" })
            onLoad?.(event)
          }}
          onError={(event) => {
            setResult({ src, status: "error" })
            onError?.(event)
          }}
        />
      )}
    </>
  )
}
