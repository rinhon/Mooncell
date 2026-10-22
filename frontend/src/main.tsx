import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import "./index.css"
import App from "./app"
import { ToastProvider } from "./components/ui/toast"
import { TooltipProvider } from "./components/ui/tooltip"
import { MotionConfig } from "motion/react"

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } })
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={350}>
          <ToastProvider>
            <App />
          </ToastProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </MotionConfig>
  </StrictMode>,
)
