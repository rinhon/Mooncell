import { useCallback, useState, type ImgHTMLAttributes } from "react"
import { cn } from "@/lib/utils"
import "./fade-in-image.css"

/** 已缓存的封面直接就绪，网络图片下载完成后再渐显。 */
export function FadeInImage({ src, className, onLoad, alt = "", decoding = "async", ...props }: Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & { src: string }) {
  const [loadedSrc, setLoadedSrc] = useState<string>()
  const imageRef = useCallback((image: HTMLImageElement | null) => {
    if (image?.complete && image.naturalWidth > 0) setLoadedSrc(src)
  }, [src])

  return <img {...props} ref={imageRef} src={src} alt={alt} decoding={decoding}
    className={cn("fade-in-image", className)} data-loaded={loadedSrc === src || undefined}
    onLoad={event => { setLoadedSrc(src); onLoad?.(event) }}/>
}
