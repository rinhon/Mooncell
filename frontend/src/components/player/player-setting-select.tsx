import { useId } from "react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

interface SettingOption {
  value: string
  label: string
  disabled?: boolean
  title?: string
}

export function PlayerSettingSelect({
  label,
  value,
  options,
  onValueChange,
  disabled,
  className,
  portalContainer,
}: {
  label: string
  value: string
  options: SettingOption[]
  onValueChange: (value: string) => void
  disabled?: boolean
  className?: string
  portalContainer: HTMLElement | null
}) {
  const labelId = useId()
  return (
    <div className={["player-setting", className].filter(Boolean).join(" ")}>
      <span id={labelId}>{label}</span>
      <Select value={value} onValueChange={onValueChange} disabled={disabled}>
        <SelectTrigger className="player-select-trigger" aria-labelledby={labelId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent
          className="player-select-menu"
          portalContainer={portalContainer}
          align="start"
          collisionPadding={12}
        >
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              disabled={option.disabled}
              title={option.title}
              className="player-select-option"
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
