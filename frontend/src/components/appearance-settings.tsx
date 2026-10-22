import { useState, type CSSProperties } from "react"
import { Check, Palette } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { themes, useTheme, type Theme } from "@/lib/theme"
import "./appearance-settings.css"

export function AppearanceSettingsSection() {
  const { theme, setTheme } = useTheme()
  const [storageUnavailable, setStorageUnavailable] = useState(false)

  function selectTheme(value: Theme) {
    setStorageUnavailable(!setTheme(value))
  }

  return (
    <section id="appearance" aria-label="外观与主题" className="lg:col-span-2">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>外观与主题</CardTitle>
            <CardDescription>选择喜欢的配色，立即生效并自动保存在当前浏览器。</CardDescription>
          </div>
          <Palette size={20} className="shrink-0 text-muted" aria-hidden="true" />
        </CardHeader>
        <CardContent>
          <fieldset className="theme-options">
            <legend className="sr-only">选择主题</legend>
            {(Object.keys(themes) as Theme[]).map((value) => {
              const option = themes[value]
              return (
                <label key={value} className="theme-option">
                  <input
                    type="radio"
                    name="theme"
                    value={value}
                    checked={theme === value}
                    onChange={() => selectTheme(value)}
                    className="sr-only"
                  />
                  <span className="theme-option-body">
                    <span
                      className="theme-preview"
                      aria-hidden="true"
                      style={
                        {
                          "--preview-bg": option.background,
                          "--preview-surface": option.surface,
                          "--preview-ink": option.ink,
                          "--preview-accent": option.accent,
                        } as CSSProperties
                      }
                    >
                      <span className="theme-preview-nav">
                        <span>MOONCELL</span>
                        <i />
                        <i />
                        <i />
                      </span>
                      <span className="theme-preview-content">
                        <span className="theme-preview-title" />
                        <span className="theme-preview-cards">
                          {[0, 1, 2].map((index) => (
                            <span key={index}>
                              <i />
                              <i />
                              <b />
                            </span>
                          ))}
                        </span>
                      </span>
                      <span className="theme-preview-swatches">
                        <i style={{ background: option.accent }} />
                        <i style={{ background: option.background }} />
                      </span>
                    </span>
                    <span className="theme-option-heading">
                      <span>{option.name}</span>
                      <span className="theme-option-check" aria-hidden="true">
                        <Check size={13} />
                      </span>
                    </span>
                    <span className="theme-option-description">{option.description}</span>
                  </span>
                </label>
              )
            })}
          </fieldset>
          <p className="theme-status" role="status">
            {storageUnavailable
              ? "主题已切换。当前浏览器无法保存偏好，刷新后可能恢复默认主题。"
              : `当前主题：${themes[theme].name}`}
          </p>
        </CardContent>
      </Card>
    </section>
  )
}
