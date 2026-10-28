import { createContext } from "react"

/** 页面与子模块共同遵循同一会话中的路由入场策略。 */
export const PageMotionContext = createContext({ animateEntry: true, animateCards: true })
