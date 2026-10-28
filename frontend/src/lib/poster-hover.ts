import { createContext } from "react"

export const PosterHoverContext = createContext<number | undefined>(undefined)

export const posterHoverTransition = {
  type: "tween",
  duration: 0.8,
  ease: [0.16, 1, 0.3, 1],
} as const
