// Adapted from Aceternity UI: https://ui.aceternity.com/components/multi-step-loader
import { useEffect, useState, type ReactNode } from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { cn } from "@/lib/utils"

type LoadingState = { text: string }

type MultiStepLoaderProps = {
  loadingStates: LoadingState[]
  loading?: boolean
  duration?: number
  loop?: boolean
  /** When supplied, real application progress controls the active step. */
  value?: number
  className?: string
  children?: ReactNode
}

function CheckIcon({ filled, className }: { filled: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={1.5}
      className={cn("size-6 shrink-0", className)}
      aria-hidden="true"
    >
      {filled ? (
        <path
          fillRule="evenodd"
          d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12Zm13.36-1.814a.75.75 0 1 0-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 0 0-1.06 1.06l2.25 2.25a.75.75 0 0 0 1.14-.094l3.75-5.25Z"
          clipRule="evenodd"
        />
      ) : (
        <path d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
      )}
    </svg>
  )
}

export function MultiStepLoader({
  loadingStates,
  loading = false,
  duration = 2000,
  loop = true,
  value,
  className,
  children,
}: MultiStepLoaderProps) {
  const [currentState, setCurrentState] = useState(0)
  const reducedMotion = useReducedMotion()
  const lastStep = Math.max(0, loadingStates.length - 1)
  const activeStep = Math.max(0, Math.min(value ?? currentState, lastStep))

  useEffect(() => {
    if (!loading) {
      setCurrentState(0)
      return
    }
    if (value !== undefined || (!loop && currentState >= lastStep)) return
    const timeout = setTimeout(() => {
      setCurrentState((previous) => (loop ? (previous + 1) % (lastStep + 1) : Math.min(previous + 1, lastStep)))
    }, duration)
    return () => clearTimeout(timeout)
  }, [currentState, loading, loop, lastStep, duration, value])

  return (
    <AnimatePresence>
      {loading && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reducedMotion ? 0 : 0.25 }}
          className={cn(
            "fixed inset-0 z-[100] flex items-center justify-center overflow-hidden bg-[#070b09]/95 text-white backdrop-blur-2xl",
            className,
          )}
        >
          {children}
          <div className="relative mx-6 w-full max-w-sm">
            <div
              className="pointer-events-none absolute -inset-28 bg-[radial-gradient(ellipse_at_center,#6be8970d,transparent_65%)]"
              aria-hidden="true"
            />
            <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
              {loadingStates[activeStep]?.text}
            </div>
            <div
              className="relative h-64 overflow-hidden [mask-image:linear-gradient(transparent,black_15%,black_80%,transparent)]"
              aria-hidden="true"
            >
              {loadingStates.map((state, index) => (
                <motion.div
                  key={state.text}
                  className={cn(
                    "relative flex h-11 items-center gap-3 text-sm sm:text-base",
                    index === activeStep ? "font-medium text-[#8ce8ad]" : "text-white/75",
                  )}
                  initial={false}
                  animate={{
                    opacity: Math.max(1 - Math.abs(index - activeStep) * 0.23, 0),
                    y: reducedMotion ? 0 : -activeStep * 44,
                  }}
                  style={{ top: reducedMotion ? 28 : 104 }}
                  transition={{ duration: reducedMotion ? 0 : 0.5, ease: [0.22, 1, 0.36, 1] }}
                >
                  <CheckIcon filled={index <= activeStep} />
                  <span>{state.text}</span>
                </motion.div>
              ))}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
