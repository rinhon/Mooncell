import { useContext, type CSSProperties, type ImgHTMLAttributes, type ReactNode } from "react"
import { motion, useReducedMotion, type HTMLMotionProps } from "motion/react"
import { useImageRecovery } from "@/hooks/use-image-recovery"
import { spring } from "@/lib/motion"
import { PosterHoverContext, posterHoverTransition } from "@/lib/poster-hover"
import { cn } from "@/lib/utils"
import "./fade-in-image.css"

type FadeInImageProps = Omit<HTMLMotionProps<"img">, "src"> & {
  src: string
  placeholder?: ReactNode
  fallback?: ReactNode
  hoverZoom?: boolean
}

/** 固定尺寸的父容器负责布局；首屏由页面统一等待，单图失败继续使用占位并恢复。 */
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
  hoverZoom = true,
  alt = "",
  decoding = "async",
  loading,
  style,
  ...props
}: FadeInImageProps) {
  const { attempt, status, failed, ref, onLoad: loaded, onError: failedLoad } = useImageRecovery()
  const reducedMotion = useReducedMotion()
  const hoverScale = useContext(PosterHoverContext)
  const animateZoom = hoverZoom && hoverScale !== undefined

  return (
    <>
      {status === "loading" && !failed && placeholder}
      {failed && fallback}
      {status !== "error" &&
        (animateZoom ? (
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
            animate={{
              opacity: status === "loaded" ? 1 : 0,
              scale: reducedMotion ? 1 : hoverScale,
            }}
            transition={reducedMotion ? { duration: 0 } : { opacity: spring.gentle, scale: posterHoverTransition }}
            className={cn("fade-in-image", className)}
            data-loaded={status === "loaded" || undefined}
            onLoad={(event) => {
              if (loaded()) onLoad?.(event)
            }}
            onError={(event) => {
              if (failedLoad()) onError?.(event)
            }}
          />
        ) : (
          <img
            {...(props as ImgHTMLAttributes<HTMLImageElement>)}
            key={attempt}
            ref={ref}
            src={src}
            alt={alt}
            decoding={decoding}
            loading={attempt > 0 ? "eager" : loading}
            style={
              (failed
                ? { ...style, display: "none", opacity: 0 }
                : { ...style, opacity: status === "loaded" ? 1 : 0 }) as CSSProperties
            }
            className={cn("fade-in-image", className)}
            data-loaded={status === "loaded" || undefined}
            onLoad={(event) => {
              if (loaded()) onLoad?.(event)
            }}
            onError={(event) => {
              if (failedLoad()) onError?.(event)
            }}
          />
        ))}
    </>
  )
}
