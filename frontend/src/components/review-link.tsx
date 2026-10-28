import { forwardRef } from "react"
import { NavLink, useLocation, type NavLinkProps } from "react-router-dom"

let opener: HTMLAnchorElement | null = null
let menuOpener: HTMLElement | null = null

/** 审核以路由弹窗打开，背景页面与自己的筛选、滚动状态继续保留。 */
export const ReviewLink = forwardRef<HTMLAnchorElement, NavLinkProps>(function ReviewLink(
  { state, onClick, ...props },
  ref,
) {
  const location = useLocation()
  return (
    <NavLink
      {...props}
      ref={ref}
      state={{ ...state, backgroundLocation: location }}
      aria-haspopup="dialog"
      onClick={(event) => {
        if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) {
          opener = event.currentTarget
          const trigger = opener.closest(".top-nav-menu")
            ? ".top-nav-more-trigger"
            : opener.closest(".sm-panel")
              ? ".sm-trigger"
              : opener.closest(".notification-item")
                ? ".notification-trigger"
                : null
          menuOpener = trigger ? document.querySelector<HTMLElement>(trigger) : null
        }
        onClick?.(event)
      }}
    />
  )
})

export function restoreReviewFocus(event: Event) {
  const target =
    opener?.isConnected && opener.getClientRects().length > 0 && !opener.closest('[data-state="closed"]')
      ? opener
      : menuOpener?.isConnected && menuOpener.getClientRects().length > 0
        ? menuOpener
        : document.querySelector<HTMLElement>(".brand-mark")
  opener = null
  menuOpener = null
  if (target) {
    event.preventDefault()
    target.focus({ preventScroll: true })
  }
}
