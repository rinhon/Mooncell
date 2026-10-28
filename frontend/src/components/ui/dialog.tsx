import { spring } from "@/lib/motion"
import * as React from "react"
import { X } from "lucide-react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { AnimatePresence, motion, useReducedMotion, type HTMLMotionProps } from "motion/react"
import { cn } from "@/lib/utils"

const DialogOpenContext = React.createContext(false)
const dialogSpring = spring.snappy
// 高度弹簧使用临界阻尼（damping ≥ 2√stiffness），避免回弹时短暂低于内容高度而闪出滚动条。
const heightSpring = { type: "spring", stiffness: 300, damping: 35 } as const

export function Dialog({
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen)
  const open = controlledOpen ?? uncontrolledOpen
  return (
    <DialogOpenContext.Provider value={open}>
      <DialogPrimitive.Root
        {...props}
        open={open}
        onOpenChange={(next) => {
          if (controlledOpen === undefined) setUncontrolledOpen(next)
          onOpenChange?.(next)
        }}
      >
        {children}
      </DialogPrimitive.Root>
    </DialogOpenContext.Provider>
  )
}
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

const DialogSurface = React.forwardRef<
  HTMLDivElement,
  Omit<HTMLMotionProps<"div">, "children"> & { animateSize: boolean; children?: React.ReactNode }
>(function DialogSurface(
  { animateSize, children, style, onAnimationStart, onAnimationComplete, ...props },
  forwardedRef,
) {
  const surfaceRef = React.useRef<HTMLDivElement>(null)
  const bodyRef = React.useRef<HTMLDivElement>(null)
  const [height, setHeight] = React.useState<number | null>(null)
  // 仅当内容确实超过 90vh 且高度动画已结束时才允许滚动，避免过渡期间滚动条闪烁导致重排抖动。
  const [scrollable, setScrollable] = React.useState(false)
  const [resizing, setResizing] = React.useState(false)
  const reducedMotion = useReducedMotion()

  React.useLayoutEffect(() => {
    if (!animateSize || !surfaceRef.current || !bodyRef.current) return
    const surface = surfaceRef.current
    const body = bodyRef.current
    function measure() {
      const style = getComputedStyle(surface)
      const spacing = [style.paddingTop, style.paddingBottom, style.borderTopWidth, style.borderBottomWidth].reduce(
        (sum, value) => sum + parseFloat(value),
        0,
      )
      const natural = Math.ceil(body.offsetHeight + spacing)
      const max = window.innerHeight * 0.9
      setScrollable(natural > max)
      setHeight(Math.min(natural, max))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(body)
    window.addEventListener("resize", measure)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [animateSize])

  return (
    <motion.div
      {...props}
      ref={(node) => {
        surfaceRef.current = node
        if (typeof forwardedRef === "function") forwardedRef(node)
        else if (forwardedRef) forwardedRef.current = node
      }}
      style={animateSize ? { ...style, overflowY: scrollable && !resizing ? "auto" : "hidden" } : style}
      onAnimationStart={(definition) => {
        if (animateSize) setResizing(true)
        onAnimationStart?.(definition)
      }}
      onAnimationComplete={(definition) => {
        if (animateSize) setResizing(false)
        onAnimationComplete?.(definition)
      }}
      initial={{
        opacity: 0,
        scale: reducedMotion ? 1 : animateSize ? 0.985 : 0.98,
        y: reducedMotion || !animateSize ? 0 : 10,
      }}
      animate={{ opacity: 1, scale: 1, y: 0, ...(animateSize && height !== null ? { height } : {}) }}
      exit={{ opacity: 0, scale: reducedMotion ? 1 : 0.99, y: reducedMotion || !animateSize ? 0 : 6 }}
      transition={
        animateSize
          ? {
              height: reducedMotion ? { duration: 0 } : heightSpring,
              scale: reducedMotion ? { duration: 0 } : dialogSpring,
              y: reducedMotion ? { duration: 0 } : dialogSpring,
              opacity: reducedMotion ? { duration: 0 } : spring.snappy,
            }
          : reducedMotion
            ? { duration: 0 }
            : dialogSpring
      }
    >
      {animateSize ? <div ref={bodyRef}>{children}</div> : children}
    </motion.div>
  )
})

export function DialogContent({
  className,
  children,
  animateSize = false,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { animateSize?: boolean }) {
  const open = React.useContext(DialogOpenContext)
  const reducedMotion = useReducedMotion()
  return (
    <AnimatePresence>
      {open && (
        <DialogPrimitive.Portal forceMount>
          <DialogPrimitive.Overlay forceMount asChild key="overlay">
            <motion.div
              className="radix-overlay fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={reducedMotion ? { duration: 0 } : dialogSpring}
            />
          </DialogPrimitive.Overlay>
          <DialogPrimitive.Content {...props} forceMount asChild key="content">
            <DialogSurface
              animateSize={animateSize}
              className={cn(
                [
                  "radix-dialog-content fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-3xl",
                  "-translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-panel border border-border",
                  "bg-surface-raised p-6 shadow-2xl outline-none sm:p-7",
                ].join(" "),
                className,
              )}
            >
              {children}
              <DialogPrimitive.Close
                className={[
                  "absolute right-4 top-4 grid size-9 place-items-center rounded-control text-muted",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
                ].join(" ")}
                aria-label="关闭"
              >
                <X size={17} />
              </DialogPrimitive.Close>
            </DialogSurface>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      )}
    </AnimatePresence>
  )
}

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mb-6 grid gap-1.5 pr-10", className)} {...props} />
}
export function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn("text-xl font-semibold tracking-tight", className)} {...props} />
}
export function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn("text-sm leading-6 text-muted", className)} {...props} />
}
export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />
}
