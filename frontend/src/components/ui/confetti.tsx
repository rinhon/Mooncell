// Adapted from Magic UI's Confetti. See confetti.LICENSE.
// https://magicui.design/docs/components/confetti
"use client"

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, type ComponentPropsWithoutRef } from "react"
import confetti, { type CreateTypes, type GlobalOptions, type Options } from "canvas-confetti"
import { cn } from "@/lib/utils"

export type ConfettiRef = { fire: (options?: Options) => Promise<void> }

type Props = ComponentPropsWithoutRef<"canvas"> & {
  options?: Options
  globalOptions?: GlobalOptions
  manualstart?: boolean
}

export const Confetti = forwardRef<ConfettiRef, Props>(function Confetti({ options, globalOptions, manualstart = false, className, ...props }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const instanceRef = useRef<CreateTypes | null>(null)
  const optionsRef = useRef(options)
  const globalOptionsRef = useRef(globalOptions)

  useEffect(() => { optionsRef.current = options }, [options])
  useEffect(() => { globalOptionsRef.current = globalOptions }, [globalOptions])

  useEffect(() => {
    if (canvasRef.current) {
      instanceRef.current = confetti.create(canvasRef.current, {
        resize: true,
        useWorker: true,
        ...globalOptionsRef.current,
        disableForReducedMotion: true,
      })
    }
    return () => {
      instanceRef.current?.reset()
      instanceRef.current = null
    }
  }, [])

  const fire = useCallback(async (overrides: Options = {}) => {
    try {
      await instanceRef.current?.({ ...optionsRef.current, ...overrides, disableForReducedMotion: true })
    } catch (error) {
      console.error("Confetti error:", error)
    }
  }, [])

  useImperativeHandle(ref, () => ({ fire }), [fire])

  useEffect(() => { if (!manualstart) void fire() }, [manualstart, fire])

  return <canvas {...props} ref={canvasRef} aria-hidden="true" className={cn("pointer-events-none", className)}/>
})
