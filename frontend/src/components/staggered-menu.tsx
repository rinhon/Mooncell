// Inspired by React Bits' StaggeredMenu (David Haz), rebuilt with Motion springs.
// See staggered-menu.LICENSE for the React Bits license notice.
import { useEffect, useState, type MouseEvent } from "react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { AnimatePresence, motion, useReducedMotion, type Variants } from "motion/react"
import { Plus, X } from "lucide-react"
import { NavLink, useLocation } from "react-router-dom"
import { spring } from "@/lib/motion"
import { navigation, utilityNavigation } from "@/lib/navigation"
import { cn } from "@/lib/utils"
import "./staggered-menu.css"

type StaggeredMenuProps = {
  position?: "left"
}

export function StaggeredMenuTrigger({ open }: { open: boolean }) {
  const reducedMotion = useReducedMotion()
  return (
    <DialogPrimitive.Trigger asChild>
      <button type="button" className="sm-trigger" data-open={open} aria-label={open ? "关闭导航菜单" : "打开导航菜单"}>
        <span className="sm-trigger-label-window" aria-hidden="true">
          <motion.span
            className="sm-trigger-labels"
            initial={false}
            animate={{ y: open ? "-50%" : "0%" }}
            transition={reducedMotion ? { duration: 0 } : spring.snappy}
          >
            <span>菜单</span>
            <span>关闭</span>
          </motion.span>
        </span>
        <motion.span
          className="sm-trigger-icon"
          aria-hidden="true"
          initial={false}
          animate={{ rotate: open ? 225 : 0, scale: 1 }}
          transition={reducedMotion ? { duration: 0 } : spring.snappy}
        >
          <Plus size={18} />
        </motion.span>
      </button>
    </DialogPrimitive.Trigger>
  )
}

/** Radix 提供模态焦点锁定、Esc、滚动锁定与关闭后焦点恢复。 */
export function StaggeredMenu({ position = "left" }: StaggeredMenuProps) {
  const [open, setOpen] = useState(false)
  const location = useLocation()
  const reducedMotion = useReducedMotion()

  useEffect(() => {
    setOpen(false)
  }, [location])
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)")
    const closeOnDesktop = () => {
      if (media.matches) setOpen(false)
    }
    media.addEventListener("change", closeOnDesktop)
    return () => media.removeEventListener("change", closeOnDesktop)
  }, [])

  const layerVariants = (enterDelay: number, exitDelay: number): Variants => ({
    closed: { x: "-102%", transition: reducedMotion ? { duration: 0 } : { ...spring.gentle, delay: exitDelay } },
    open: { x: "0%", transition: reducedMotion ? { duration: 0 } : { ...spring.gentle, delay: enterDelay } },
  })
  const listVariants: Variants = {
    closed: { transition: { staggerChildren: 0 } },
    open: { transition: { staggerChildren: reducedMotion ? 0 : 0.042, delayChildren: reducedMotion ? 0 : 0.08 } },
  }
  const itemVariants: Variants = {
    closed: { y: reducedMotion ? 0 : "110%", rotate: reducedMotion ? 0 : 4 },
    open: { y: 0, rotate: 0 },
  }
  const closeOnNavigate = (event: MouseEvent<HTMLAnchorElement>) => {
    // 保留新标签页/新窗口操作，当前路由的链接也能正常关闭抽屉。
    if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) setOpen(false)
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <StaggeredMenuTrigger open={open} />
      <DialogPrimitive.Portal forceMount>
        <AnimatePresence>
          {open && (
            <motion.div
              key="staggered-menu"
              className="sm-root"
              data-position={position}
              initial="closed"
              animate="open"
              exit="closed"
            >
              <DialogPrimitive.Overlay forceMount asChild>
                <div className="sm-backdrop" aria-hidden="true" onClick={() => setOpen(false)} />
              </DialogPrimitive.Overlay>
              <div className="sm-drawer">
                <motion.div
                  className="sm-prelayer sm-prelayer-1"
                  aria-hidden="true"
                  variants={layerVariants(0, 0.12)}
                />
                <motion.div
                  className="sm-prelayer sm-prelayer-2"
                  aria-hidden="true"
                  variants={layerVariants(0.04, 0.06)}
                />
                <DialogPrimitive.Content forceMount asChild aria-describedby={undefined}>
                  <motion.div className="sm-panel" variants={layerVariants(0.08, 0)}>
                    <div className="sm-panel-header">
                      <DialogPrimitive.Title>探索 Mooncell</DialogPrimitive.Title>
                      <DialogPrimitive.Close className="sm-close" aria-label="关闭导航菜单">
                        <X size={20} />
                      </DialogPrimitive.Close>
                    </div>
                    <nav className="sm-navigation" aria-label="主要导航">
                      <motion.ul className="sm-list" variants={listVariants}>
                        {navigation.map(({ to, label, icon: Icon }, index) => (
                          <li className="sm-item" key={to}>
                            <motion.div
                              className="sm-item-inner"
                              variants={itemVariants}
                              transition={reducedMotion ? { duration: 0 } : spring.snappy}
                            >
                              <NavLink
                                to={to}
                                end={to === "/"}
                                onClick={closeOnNavigate}
                                className={({ isActive }) => cn("sm-link", isActive && "active")}
                              >
                                <span className="sm-active-indicator" aria-hidden="true" />
                                <span className="sm-item-icon" aria-hidden="true">
                                  <Icon size={23} strokeWidth={1.5} />
                                </span>
                                <span className="sm-item-title">{label}</span>
                                <span className="sm-item-number" aria-hidden="true">
                                  {String(index + 1).padStart(2, "0")}
                                </span>
                              </NavLink>
                            </motion.div>
                          </li>
                        ))}
                      </motion.ul>
                    </nav>
                    <nav className="sm-utilities" aria-label="管理工具">
                      <p className="sm-utilities-heading">管理工具</p>
                      <div className="sm-utility-list">
                        {utilityNavigation.map(({ to, label, icon: Icon }) => (
                          <div className="sm-utility-item" key={to}>
                            <NavLink
                              to={to}
                              onClick={closeOnNavigate}
                              className={({ isActive }) => cn("sm-utility-link", isActive && "active")}
                            >
                              <Icon size={16} strokeWidth={1.6} aria-hidden="true" />
                              <span>{label}</span>
                            </NavLink>
                          </div>
                        ))}
                      </div>
                    </nav>
                  </motion.div>
                </DialogPrimitive.Content>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
