import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"
import { useQuery } from "@tanstack/react-query"
import { motion, useReducedMotion } from "motion/react"
import { MoreHorizontal } from "lucide-react"
import { NavLink, useLocation } from "react-router-dom"
import { NotificationCenter } from "@/components/notification-center"
import { StaggeredMenu } from "@/components/staggered-menu"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { useOverflowMenu } from "@/hooks/use-overflow-menu"
import { api, type Dashboard } from "@/lib/api"
import { spring } from "@/lib/motion"
import { navigation, utilityNavigation } from "@/lib/navigation"
import { cn } from "@/lib/utils"
import "./top-nav.css"

const highlightWidth = 100

/** 只使用导航内部横坐标，避免吸顶导航在切页时混入页面滚动位移。 */
function useNavigationBounds(
  container: RefObject<HTMLDivElement | null>,
  selector: string | null,
  layoutVersion: string,
  labelOnly = false,
) {
  const [bounds, setBounds] = useState<{ x: number; width: number } | null>(null)
  const [visible, setVisible] = useState(false)

  useLayoutEffect(() => {
    const row = container.current
    if (!row) return
    const measure = () => {
      const link = selector ? row.querySelector<HTMLAnchorElement>(selector) : null
      if (!link || !link.offsetWidth) {
        setVisible(false)
        return
      }
      const label = labelOnly ? link.querySelector<HTMLElement>(".top-nav-label") : null
      setBounds({ x: link.offsetLeft + (label?.offsetLeft ?? 0), width: label?.offsetWidth ?? link.offsetWidth })
      setVisible(true)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    for (const link of row.querySelectorAll("a")) observer.observe(link)
    return () => observer.disconnect()
  }, [container, selector, layoutVersion, labelOnly])

  return { bounds, visible }
}

export function TopNav() {
  const location = useLocation()
  const reducedMotion = useReducedMotion()
  const [hovered, setHovered] = useState<string | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const { measureRef, visibleCount } = useOverflowMenu(listRef, navigation.length)
  const layoutVersion = `${location.pathname}:${visibleCount}`
  const indicator = useNavigationBounds(listRef, 'a[aria-current="page"]', layoutVersion, true)
  const hover = useNavigationBounds(listRef, hovered ? `a[href="${hovered}"]` : null, layoutVersion)
  const dashboard = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api<Dashboard>("/dashboard"),
    staleTime: 60_000,
    refetchInterval: 60_000,
  })
  const needsReview = dashboard.data?.needs_review ?? 0
  const visible = navigation.slice(0, visibleCount)
  const overflow = navigation.slice(visibleCount)
  const moreItems = [...overflow, ...utilityNavigation]
  const moreActive = moreItems.some(
    (item) => location.pathname === item.to || location.pathname.startsWith(`${item.to}/`),
  )

  useEffect(() => {
    setMoreOpen(false)
    setHovered(null)
  }, [location.pathname])
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)")
    const closeOnNarrow = () => {
      if (!media.matches) setMoreOpen(false)
    }
    media.addEventListener("change", closeOnNarrow)
    return () => media.removeEventListener("change", closeOnNarrow)
  }, [])

  return (
    <div className="top-navigation-content">
      <nav className="top-nav" aria-label="主要导航">
        <div
          ref={listRef}
          className="top-nav-list"
          onPointerLeave={() => setHovered(null)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setHovered(null)
          }}
        >
          {hover.bounds && (
            <motion.span
              className="top-nav-hover"
              aria-hidden="true"
              initial={false}
              style={{ width: highlightWidth, transformOrigin: "left" }}
              animate={{
                x: hover.bounds.x,
                scaleX: hover.bounds.width / highlightWidth,
                opacity: hover.visible ? 1 : 0,
              }}
              transition={reducedMotion ? { duration: 0 } : spring.snappy}
            />
          )}
          {indicator.bounds && (
            <motion.span
              className="top-nav-indicator"
              aria-hidden="true"
              initial={false}
              style={{
                width: highlightWidth,
                transformOrigin: "left",
                visibility: indicator.visible ? "visible" : "hidden",
              }}
              animate={{ x: indicator.bounds.x, scaleX: indicator.bounds.width / highlightWidth }}
              transition={reducedMotion ? { duration: 0 } : spring.snappy}
            />
          )}
          {visible.map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) => cn("top-nav-link", isActive && "active")}
              onPointerEnter={(event) => {
                if (event.pointerType === "mouse") setHovered(to)
              }}
              onFocus={() => setHovered(to)}
            >
              <span className="top-nav-label">{label}</span>
            </NavLink>
          ))}
        </div>
        <div ref={measureRef} className="top-nav-measure" aria-hidden="true" inert>
          {navigation.map((item) => (
            <span className="top-nav-link" key={item.to}>
              {item.label}
            </span>
          ))}
        </div>
      </nav>
      <div className="top-navigation-right">
        <div className="top-actions">
          <NotificationCenter />
        </div>
        <div className="top-nav-more">
          <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn("top-nav-more-trigger", moreActive && "active")}
                aria-label={needsReview ? `更多导航，${needsReview} 项待审核` : "更多导航"}
              >
                <MoreHorizontal size={18} aria-hidden="true" />
                <span>更多</span>
                {needsReview > 0 && (
                  <span className="top-nav-badge" aria-hidden="true">
                    {needsReview > 99 ? "99+" : needsReview}
                  </span>
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="top-nav-menu" aria-label="更多导航">
              {moreItems.map(({ to, label, icon: Icon }, index) => (
                <DropdownMenuItem key={to} asChild>
                  <NavLink
                    to={to}
                    end={to === "/"}
                    className={cn(
                      "top-nav-menu-link",
                      overflow.length > 0 && index === overflow.length && "top-nav-utility-start",
                    )}
                  >
                    <Icon size={17} aria-hidden="true" />
                    <span>{label}</span>
                    {to === "/review" && needsReview > 0 && (
                      <span className="top-nav-badge" aria-label={`${needsReview} 项待审核`}>
                        {needsReview > 99 ? "99+" : needsReview}
                      </span>
                    )}
                  </NavLink>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <StaggeredMenu needsReview={needsReview} />
      </div>
    </div>
  )
}
