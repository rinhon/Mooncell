import { TopNav } from "@/components/top-nav"
import { NativeButton } from "@/components/ui/button"
import { GradualBlur } from "@/components/ui/gradual-blur"
import { useEffect, useState, type ReactNode } from "react"
import { motion, useReducedMotion } from "motion/react"
import { useLocation, useNavigate } from "react-router-dom"
import StrokeText from "@/components/stroke-text"
import { spring } from "@/lib/motion"
import { PageMotionContext } from "@/lib/page-motion"
import { cn } from "@/lib/utils"

const routeVisitKey = "mooncell-visited-routes"
const logoVisitKey = "mooncell-logo-played"
const visitedRoutes = new Set<string>(
  (() => {
    try {
      const value: unknown = JSON.parse(sessionStorage.getItem(routeVisitKey) ?? "[]")
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
    } catch {
      return []
    }
  })(),
)
let logoPlayed = false

function PageStage({
  pathname,
  detailRoute,
  children,
}: {
  pathname: string
  detailRoute: boolean
  children: ReactNode
}) {
  const reducedMotion = useReducedMotion()
  const [firstVisit] = useState(() => !visitedRoutes.has(pathname))
  const animateEntry = firstVisit && !detailRoute && !reducedMotion
  useEffect(() => {
    visitedRoutes.add(pathname)
    try {
      sessionStorage.setItem(routeVisitKey, JSON.stringify([...visitedRoutes]))
    } catch {
      /* 存储禁用时保留内存中的会话记录。 */
    }
  }, [pathname])

  return (
    <PageMotionContext.Provider value={{ animateEntry }}>
      <motion.div
        className="page-content"
        initial={animateEntry ? { opacity: 0, y: 8 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={reducedMotion ? { duration: 0 } : spring.gentle}
      >
        {children}
      </motion.div>
    </PageMotionContext.Provider>
  )
}

/** 顶部导航保持 78px，页面内容在下方工作区切换。 */
export function AppShell({ children }: { children: ReactNode }) {
  const location = useLocation()
  const detailRoute = /^\/shows\/[^/]+\/?$/.test(location.pathname)
  const navigate = useNavigate()
  const [playLogoOnMount] = useState(() => {
    try {
      return !logoPlayed && sessionStorage.getItem(logoVisitKey) !== "1"
    } catch {
      return !logoPlayed
    }
  })
  useEffect(() => {
    logoPlayed = true
    try {
      sessionStorage.setItem(logoVisitKey, "1")
    } catch {
      /* 存储禁用时保留内存中的会话记录。 */
    }
  }, [])

  return (
    <div className={cn("app-frame", detailRoute && "is-show-detail")}>
      <header className="top-navigation">
        <GradualBlur
          position="top"
          height="108px"
          strength={2.6}
          divCount={3}
          curve="bezier"
          tint="var(--shell-top-tint)"
          className="top-navigation-blur"
        />
        <NativeButton className="brand-mark" aria-label="MOONCELL · 返回首页" onClick={() => navigate("/")}>
          <StrokeText
            text="MOONCELL"
            trigger="hover"
            playOnMount={playLogoOnMount}
            strokeColor="var(--accent)"
            fillColor="var(--accent)"
            fontSize={28}
            fontWeight={800}
            letterSpacing={1.2}
            strokeWidth={0.7}
            drawDuration={0.9}
            fillDelay={0.1}
            stagger={0.045}
          />
        </NativeButton>
        <TopNav />
      </header>

      <section className="app-workspace">
        <main className="content-stage">
          <PageStage key={location.pathname} pathname={location.pathname} detailRoute={detailRoute}>
            {children}
          </PageStage>
        </main>
      </section>
    </div>
  )
}
