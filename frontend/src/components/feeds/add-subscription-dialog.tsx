import { useState, type ReactNode } from "react"
import { useNavigate } from "react-router-dom"
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query"
import { Tabs } from "radix-ui"
import { LayoutGroup, motion, useReducedMotion } from "motion/react"
import { api, ApiError } from "@/lib/api"
import { spring } from "@/lib/motion"
import { AddSubscriptionButton } from "@/components/add-subscription-button"
import { MagnetCollectionForm } from "@/components/magnet-collection-form"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { useToast } from "@/components/ui/toast"
import { CREATE_FEED_MUTATION_KEY, RssSubscriptionForm } from "./rss-subscription-form"

function SubscriptionPanel({ value, active, children }: { value: string; active: boolean; children: ReactNode }) {
  const reducedMotion = useReducedMotion()
  return (
    <Tabs.Content value={value} forceMount asChild>
      <motion.div
        hidden={!active}
        inert={!active}
        aria-hidden={!active || undefined}
        initial={false}
        // 从上方滑入：向上的位移不计入滚动区域，不会撑出滚动条。
        animate={{ opacity: active ? 1 : 0, y: active || reducedMotion ? 0 : -5 }}
        transition={reducedMotion ? { duration: 0 } : spring.snappy}
      >
        {children}
      </motion.div>
    </Tabs.Content>
  )
}

export function AddSubscriptionDialog() {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState("rss")
  const reducedMotion = useReducedMotion()
  const navigate = useNavigate()
  const toast = useToast()
  const client = useQueryClient()
  const saving = useIsMutating({ mutationKey: CREATE_FEED_MUTATION_KEY }) > 0
  const isSaving = () => client.isMutating({ mutationKey: CREATE_FEED_MUTATION_KEY }) > 0
  function close() {
    if (!isSaving()) setOpen(false)
  }
  const prerequisites = useMutation({
    mutationFn: () => api<{ message: string }>("/feeds/prerequisites", { method: "POST" }),
    onSuccess: () => {
      setTab("rss")
      setOpen(true)
    },
    onError: (error) => {
      const path = error instanceof ApiError ? error.settingsPath : undefined
      if (path && ["/settings#tmdb", "/settings#downloader"].includes(path)) {
        toast("添加订阅前请完善设置", { description: error.message, tone: "warning" })
        navigate(path)
      } else toast("无法检查订阅配置", { description: error.message, tone: "error" })
    },
  })
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (isSaving()) return
        if (next) {
          if (!prerequisites.isPending) prerequisites.mutate()
        } else close()
      }}
    >
      <DialogTrigger asChild>
        <AddSubscriptionButton pending={prerequisites.isPending} />
      </DialogTrigger>
      <DialogContent
        animateSize
        onEscapeKeyDown={(event) => {
          if (isSaving()) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          if (isSaving()) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>添加订阅</DialogTitle>
          <DialogDescription>选择 RSS 订阅或磁力合集，匹配 TMDB 后下载整理。</DialogDescription>
        </DialogHeader>
        <Tabs.Root
          value={tab}
          onValueChange={(value) => {
            if (!isSaving()) setTab(value)
          }}
        >
          <LayoutGroup id="add-subscription-tabs">
            <Tabs.List aria-label="添加方式" className="mb-5 grid grid-cols-2 gap-1 rounded-control bg-surface p-1">
              {[
                { value: "rss", label: "RSS 订阅" },
                { value: "magnet", label: "磁力合集" },
              ].map((item) => (
                <Tabs.Trigger
                  key={item.value}
                  value={item.value}
                  disabled={saving}
                  className={[
                    "relative isolate rounded-inset px-3 py-2 text-sm text-muted outline-none transition-colors",
                    "focus-visible:ring-2 focus-visible:ring-accent data-[state=active]:text-accent",
                  ].join(" ")}
                >
                  {tab === item.value && (
                    <motion.span
                      aria-hidden="true"
                      layoutId={reducedMotion ? undefined : "active-tab"}
                      initial={false}
                      transition={spring.snappy}
                      className="absolute inset-0 -z-10 rounded-inset bg-accent-soft"
                    />
                  )}
                  {item.label}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
          </LayoutGroup>
          <SubscriptionPanel value="rss" active={tab === "rss"}>
            <RssSubscriptionForm onClose={close} onSaved={() => setOpen(false)} />
          </SubscriptionPanel>
          <SubscriptionPanel value="magnet" active={tab === "magnet"}>
            <MagnetCollectionForm onClose={() => setOpen(false)} onAdded={() => setOpen(false)} />
          </SubscriptionPanel>
        </Tabs.Root>
      </DialogContent>
    </Dialog>
  )
}
