import type { ReactNode } from "react"
import { motion, useReducedMotion, type HTMLMotionProps } from "motion/react"
import { useImageRecovery } from "@/hooks/use-image-recovery"
import { spring } from "@/lib/motion"
import { cn } from "@/lib/utils"
import "./fade-in-image.css"

type FadeInImageProps = Omit<HTMLMotionProps<"img">, "src"> & {
  src: string
  placeholder?: ReactNode
  fallback?: ReactNode
}

/** 固定尺寸的父容器负责布局；缓存命中、单图加载和失败占位均不阻塞其他内容。 */
export function FadeInImage(props: FadeInImageProps) {
  return <RecoveringImage key={props.src} {...props} />
}

function RecoveringImage({
  src,
  className,
  onLoad,
  onError,
  placeholder,
  fallback = null,
  alt = "",
  decoding = "async",
  loading,
  style,
  ...props
}: FadeInImageProps) {
  const { attempt, status, failed, ref, onLoad: loaded, onError: failedLoad } = useImageRecovery()
  const reducedMotion = useReducedMotion()

  return (
    <>
      {status === "loading" && !failed && placeholder}
      {failed && fallback}
      {status !== "error" && (
        <motion.img
          {...props}
          key={attempt}
          ref={ref}
          src={src}
          alt={alt}
          decoding={decoding}
          loading={attempt > 0 ? "eager" : loading}
          style={failed ? { ...style, display: "none" } : style}
          initial={false}
          animate={{ opacity: status === "loaded" ? 1 : 0 }}
          transition={reducedMotion ? { duration: 0 } : spring.gentle}
          className={cn("fade-in-image", className)}
          data-loaded={status === "loaded" || undefined}
          onLoad={(event) => {
            if (loaded()) onLoad?.(event)
          }}
          onError={(event) => {
            if (failedLoad()) onError?.(event)
          }}
        />
      )}
    </>
  )
}
