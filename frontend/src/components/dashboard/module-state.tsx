import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

export function ModuleError({ message, onRetry }: { message: string; onRetry: () => unknown }) {
  return (
    <div className="dashboard-module-error" role="alert">
      <p className="text-body text-ink">{message}</p>
      <Button variant="ghost" size="sm" onClick={() => void onRetry()}>
        <RefreshCw size={14} aria-hidden="true" />
        重试
      </Button>
    </div>
  )
}

export function ModuleSkeleton({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div className="dashboard-module-skeleton" role="status" aria-label={label} aria-busy="true">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="dashboard-skeleton-row" aria-hidden="true">
          <Skeleton className="h-10 w-10 shrink-0" />
          <div className="grid flex-1 gap-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  )
}
