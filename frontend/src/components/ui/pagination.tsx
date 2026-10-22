import { ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

type PaginationProps = {
  total: number
  page: number
  pageSize: number
  onPageChange: (page: number) => void
  onPageSizeChange: (size: number) => void
}

export function Pagination({ total, page, pageSize, onPageChange, onPageSizeChange }: PaginationProps) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const current = Math.min(Math.max(1, page), pageCount)
  const pages = Array.from(new Set([1, current - 1, current, current + 1, pageCount]))
    .filter((value) => value >= 1 && value <= pageCount)
    .sort((a, b) => a - b)
  return (
    <nav className="list-pagination" aria-label="列表分页">
      <p className="pagination-summary" aria-live="polite">
        共 {total} 条
        <span>
          {" "}
          · {total ? (current - 1) * pageSize + 1 : 0}–{Math.min(current * pageSize, total)} 条
        </span>
      </p>
      <div className="pagination-controls">
        <Select value={String(pageSize)} onValueChange={(value) => onPageSizeChange(Number(value))}>
          <SelectTrigger className="pagination-size" aria-label="每页条数">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[10, 20, 50, 100].map((size) => (
              <SelectItem key={size} value={String(size)}>
                {size} 条 / 页
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="ghost"
          className="pagination-button"
          aria-label="上一页"
          disabled={current === 1}
          onClick={() => onPageChange(current - 1)}
        >
          <ChevronLeft size={16} />
        </Button>
        {pages.map((value, index) => (
          <span key={value} className="pagination-page">
            {index > 0 && value - pages[index - 1] > 1 && (
              <span className="pagination-ellipsis" aria-hidden="true">
                …
              </span>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="pagination-button"
              aria-label={`第 ${value} 页`}
              aria-current={current === value ? "page" : undefined}
              onClick={() => onPageChange(value)}
            >
              {value}
            </Button>
          </span>
        ))}
        <Button
          size="sm"
          variant="ghost"
          className="pagination-button"
          aria-label="下一页"
          disabled={current === pageCount}
          onClick={() => onPageChange(current + 1)}
        >
          <ChevronRight size={16} />
        </Button>
      </div>
    </nav>
  )
}
