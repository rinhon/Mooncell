import type { ReactNode } from "react"
/** 用轻字重中文标题与微型说明建立所有页面一致的编辑式层级。 */
export function PageHeading({
  title,
  description,
  action,
}: {
  eyebrow?: string
  title: string
  description: ReactNode
  action?: ReactNode
}) {
  return (
    <header className="page-heading">
      <div className="page-heading-copy">
        <h1>{title}</h1>
        <p className="page-description">{description}</p>
      </div>
      {action && <div className="page-actions">{action}</div>}
    </header>
  )
}
