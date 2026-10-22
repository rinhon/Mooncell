import { useId, useRef, useState } from "react"
import { X } from "lucide-react"

type TagInputProps = {
  value: string[]
  onChange: (value: string[]) => void
  label: string
  disabled?: boolean
}

export function TagInput({ value, onChange, label, disabled }: TagInputProps) {
  const [draft, setDraft] = useState("")
  const input = useRef<HTMLInputElement>(null)
  const hintId = useId()
  function commit(text = draft) {
    const next = [...value]
    for (const part of text.split(/[,，\n]+/)) {
      const keyword = part.trim().slice(0, 100)
      if (keyword && !next.some((item) => item.toLowerCase() === keyword.toLowerCase()) && next.length < 20)
        next.push(keyword)
    }
    onChange(next)
    setDraft("")
  }
  return (
    <div>
      <div className="tag-input" data-disabled={disabled || undefined} onClick={() => input.current?.focus()}>
        {value.map((keyword) => (
          <span key={keyword} className="tag-input-token">
            <span>{keyword}</span>
            <button
              type="button"
              disabled={disabled}
              aria-label={`移除 ${keyword}`}
              onClick={(event) => {
                event.stopPropagation()
                onChange(value.filter((item) => item !== keyword))
                input.current?.focus()
              }}
            >
              <X size={14} />
            </button>
          </span>
        ))}
        <input
          ref={input}
          aria-label={label}
          aria-describedby={hintId}
          disabled={disabled}
          value={draft}
          maxLength={100}
          placeholder={value.length ? "添加关键词…" : "输入排除关键词…"}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (draft.trim()) commit()
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === "Enter" || event.key === "," || event.key === "，") {
              event.preventDefault()
              commit()
            }
            if (event.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1))
          }}
          onPaste={(event) => {
            const text = event.clipboardData.getData("text")
            if (/[,，\n]/.test(text)) {
              event.preventDefault()
              commit(draft + text)
            }
          }}
        />
      </div>
      <p id={hintId} className="tag-input-hint">
        输入后按回车或逗号添加，点击 × 删除。最多 20 个关键词。
      </p>
    </div>
  )
}
