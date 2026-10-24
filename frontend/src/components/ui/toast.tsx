import { createContext, useCallback, useContext, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { CheckCircle2, CircleAlert, TriangleAlert } from "lucide-react"
import SwipeToast from "@/components/swipe-toast"
import "./toast.css"

type Tone = "success" | "warning" | "error"
type Notice = { id: number; title: string; description?: string; tone: Tone; duration?: number }
type ToastFn = (title: string, options?: { description?: string; tone?: Tone; duration?: number }) => void
const ToastContext = createContext<ToastFn>(() => undefined)

export function useToast() {
  return useContext(ToastContext)
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<Notice[]>([])
  const toast = useCallback<ToastFn>((title, options) => {
    const id = Date.now() + Math.random()
    setNotices((items) => [
      ...items,
      { id, title, description: options?.description, tone: options?.tone ?? "success", duration: options?.duration },
    ])
  }, [])
  const close = useCallback((id: number) => {
    setNotices((items) => items.filter((item) => item.id !== id))
  }, [])
  return (
    <ToastContext.Provider value={toast}>
      {children}
      {createPortal(
        <div className="toast-viewport" role="region" aria-label="提示通知">
          {notices.map((notice) => (
            <SwipeToast
              key={notice.id}
              title={notice.title}
              description={notice.description}
              icon={
                notice.tone === "success" ? (
                  <CheckCircle2 size={18} strokeWidth={1.5} />
                ) : notice.tone === "warning" ? (
                  <TriangleAlert size={18} strokeWidth={1.5} />
                ) : (
                  <CircleAlert size={18} strokeWidth={1.5} />
                )
              }
              className={`toast-notice toast-notice--${notice.tone}`}
              background="var(--surface-raised)"
              color="var(--ink)"
              fuseColor="var(--muted)"
              width={380}
              duration={notice.duration ?? (notice.tone === "error" ? 0 : 3600)}
              inline
              closeButton
              onClose={() => close(notice.id)}
            />
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  )
}
