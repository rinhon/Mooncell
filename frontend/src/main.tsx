import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import "./index.css"
import App from "./app"
import Grainient from "./components/grainient"
import { ToastProvider } from "./components/ui/toast"
import { TooltipProvider } from "./components/ui/tooltip"

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } })
createRoot(document.getElementById("root")!).render(
  <StrictMode><div className="ambient-background" aria-hidden="true"><Grainient color1="#090B0A" color2="#14251A" color3="#0C100E" timeSpeed={0.3} warpStrength={1} warpAmplitude={18} rotationAmount={300} blendSoftness={0.22} grainAmount={0.018} contrast={1.05} saturation={1}/></div><QueryClientProvider client={queryClient}><TooltipProvider delayDuration={350}><ToastProvider><App /></ToastProvider></TooltipProvider></QueryClientProvider></StrictMode>,
)
