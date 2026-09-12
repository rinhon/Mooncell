import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"
import { CheckCircle2, CircleAlert, TriangleAlert, X } from "lucide-react"
import { Toast as ToastPrimitive } from "radix-ui"
import "./toast.css"

type Tone = "success" | "warning" | "error"
type Notice = { id: number; title: string; description?: string; tone: Tone; open: boolean }
type ToastFn = (title: string, options?: { description?: string; tone?: Tone }) => void
const ToastContext = createContext<ToastFn>(() => undefined)

export function useToast() { return useContext(ToastContext) }

export function ToastProvider({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<Notice[]>([])
  const toast = useCallback<ToastFn>((title, options) => {
    const id = Date.now() + Math.random()
    setNotices((items) => [...items, { id, title, description: options?.description, tone: options?.tone ?? "success", open: true }])
  }, [])
  const contextValue = useMemo(() => toast, [toast])
  function close(id: number) {
    setNotices((items) => items.map((item) => item.id === id ? { ...item, open: false } : item))
    window.setTimeout(() => setNotices((items) => items.filter((item) => item.id !== id)), 180)
  }
  return <ToastContext.Provider value={contextValue}><ToastPrimitive.Provider swipeDirection="right" duration={3600}>{children}{notices.map((notice) => <ToastPrimitive.Root key={notice.id} open={notice.open} onOpenChange={(open) => !open && close(notice.id)} data-tone={notice.tone} className="radix-toast">
    <span className="toast-icon" aria-hidden="true">{notice.tone === "success" ? <CheckCircle2 size={18} strokeWidth={1.5}/> : notice.tone === "warning" ? <TriangleAlert size={18} strokeWidth={1.5}/> : <CircleAlert size={18} strokeWidth={1.5}/>}</span>
    <div className="toast-copy"><ToastPrimitive.Title className="toast-title">{notice.title}</ToastPrimitive.Title>{notice.description&&<ToastPrimitive.Description className="toast-description">{notice.description}</ToastPrimitive.Description>}</div>
    <ToastPrimitive.Close className="toast-close" aria-label="关闭通知"><X size={15}/></ToastPrimitive.Close>
  </ToastPrimitive.Root>)}<ToastPrimitive.Viewport className="toast-viewport"/></ToastPrimitive.Provider></ToastContext.Provider>
}
