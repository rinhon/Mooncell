import type { ImgHTMLAttributes, ReactNode } from "react"
import { useImageRecovery } from "@/hooks/use-image-recovery"

type RetryImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src: string
  placeholder?: ReactNode
  fallback?: ReactNode
}

/** 保留调用方的图片样式，只负责失败占位和有界恢复。 */
export function RetryImage(props: RetryImageProps) {
  return <RecoveringImage key={props.src} {...props} />
}

function RecoveringImage({
  src,
  placeholder,
  fallback = null,
  alt = "",
  decoding = "async",
  loading,
  style,
  onLoad,
  onError,
  ...props
}: RetryImageProps) {
  const { attempt, status, failed, ref, onLoad: loaded, onError: failedLoad } = useImageRecovery()
  return (
    <>
      {status === "loading" && !failed && placeholder}
      {failed && fallback}
      {status !== "error" && (
        <img
          {...props}
          key={attempt}
          ref={ref}
          src={src}
          alt={alt}
          decoding={decoding}
          loading={attempt > 0 ? "eager" : loading}
          style={failed ? { ...style, display: "none" } : style}
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
