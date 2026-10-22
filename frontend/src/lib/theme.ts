import { useSyncExternalStore } from "react"

export type Theme = "forest" | "ocean"

export const THEME_STORAGE_KEY = "mooncell-theme"
const THEME_EVENT = "mooncell-theme-change"

export const themes = {
  forest: {
    name: "暗夜森绿",
    description: "深色底调，搭配清新的薄荷绿。",
    background: "#090b0a",
    surface: "#1d2520",
    ink: "#edf0ee",
    accent: "#6be897",
    secondary: "#62c9b6",
    gradient: ["#090B0A", "#14251A", "#0C100E"],
  },
  ocean: {
    name: "深海蓝 · 柔奶白",
    description: "柔奶白底色，搭配沉静的深海蓝。",
    background: "#F5EFEA",
    surface: "#FFFAF6",
    ink: "#122E8A",
    accent: "#122E8A",
    secondary: "#4563AD",
    gradient: ["#F5EFEA", "#E5E8F2", "#F5EFEA"],
  },
} as const

function normalizeTheme(value: string | null | undefined): Theme {
  return value === "ocean" ? "ocean" : "forest"
}

function getTheme(): Theme {
  return normalizeTheme(document.documentElement.dataset.theme)
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themes[theme].background)
  window.dispatchEvent(new Event(THEME_EVENT))
}

function subscribe(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY || event.key === null) applyTheme(normalizeTheme(event.newValue))
  }
  window.addEventListener(THEME_EVENT, onChange)
  window.addEventListener("storage", onStorage)
  return () => {
    window.removeEventListener(THEME_EVENT, onChange)
    window.removeEventListener("storage", onStorage)
  }
}

/** 即时应用主题；浏览器禁用存储时仍允许在当前页面切换。 */
export function setTheme(theme: Theme): boolean {
  applyTheme(theme)
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
    return true
  } catch {
    return false
  }
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getTheme, () => "forest" as Theme)
  return { theme, palette: themes[theme], setTheme }
}
