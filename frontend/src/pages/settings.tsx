import { SubscriptionSettingsSection } from "@/components/subscription-settings"
import { AppearanceSettingsSection } from "@/components/appearance-settings"
import { TmdbSettingsSection } from "@/components/tmdb-settings"
import { useEffect } from "react"
import { useLocation } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { FolderTree, LogOut } from "lucide-react"
import { api, type ParsedRelease } from "@/lib/api"
import { DownloaderSettingsSection } from "@/components/downloader-settings"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field } from "@/components/field"
import { Input } from "@/components/ui/input"
import { FolderPicker, type LibraryPath } from "@/components/folder-picker"
import { LibraryScan } from "@/components/library-scan"
import { PageHeading } from "@/components/page-heading"
import { Button } from "@/components/ui/button"
import { useToast } from "@/components/ui/toast"

type Preview = {
  parsed: ParsedRelease
  directory: string
  filename: string
  full_path: string
  library_root: string
  folder_name: string
  season_folder: string
  separator: string
}

/** 集中管理下载器连接，以及媒体库目录和文件命名。 */
export function SettingsPage() {
  const client = useQueryClient()
  const toast = useToast()
  const logout = useMutation({
    mutationFn: () => api("/auth/logout", { method: "POST" }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["auth"] }),
    onError: (error) => toast("退出登录失败", { description: error.message, tone: "error" }),
  })
  const { hash } = useLocation()
  useEffect(() => {
    if (["#appearance", "#tmdb", "#downloader"].includes(hash)) document.getElementById(hash.slice(1))?.scrollIntoView()
  }, [hash])
  const library = useQuery({ queryKey: ["library-settings"], queryFn: () => api<LibraryPath>("/settings/library") })
  const root = library.data?.library_root ?? ""
  const preview = useQuery({
    queryKey: ["path-preview", root],
    queryFn: () =>
      api<Preview>("/setup/path-preview", { method: "POST", body: JSON.stringify({ library_root: root }) }),
    enabled: Boolean(root),
  })
  return (
    <>
      <PageHeading
        eyebrow="Configuration"
        title="设置"
        description="管理主题外观、下载器连接、订阅刷新、TMDB 和媒体库保存路径。"
      />
      <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <AppearanceSettingsSection />
        <DownloaderSettingsSection />
        <SubscriptionSettingsSection />
        <section aria-label="保存路径" className="grid">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>保存路径</CardTitle>
                <CardDescription>选择媒体库根目录，预览最终目录与文件名。</CardDescription>
              </div>
              <FolderTree size={20} className="text-muted" />
            </CardHeader>
            <CardContent className="grid items-start gap-5">
              <div className="min-w-0">
                <Field label="媒体库根目录">
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      className="min-w-0 flex-1 basis-48"
                      value={root}
                      readOnly
                      placeholder={library.isPending ? "正在读取保存路径…" : "请选择文件夹"}
                    />
                    <FolderPicker value={root} onSaved={() => {}} />
                  </div>
                  {library.error && (
                    <p role="alert" className="mt-1 text-xs text-danger">
                      {library.error.message}
                    </p>
                  )}
                </Field>
                <p className="mt-3 text-[13px] leading-6 text-muted">
                  选择后自动保存。目录结构兼容 Plex、Jellyfin 与 Emby。
                </p>
                <div className="mt-4">
                  <LibraryScan />
                </div>
              </div>
              <div className="min-w-0">
                <p className="mb-2 text-sm font-medium text-ink">目录预览</p>
                {preview.data ? (
                  <div className="rounded-inset bg-surface/20 p-3 font-mono text-xs leading-6 text-ink ring-1 ring-border">
                    <div className="whitespace-normal break-all">
                      <p>
                        {preview.data.library_root}
                        {preview.data.library_root.endsWith(preview.data.separator) ? "" : preview.data.separator}
                      </p>
                      <p>
                        └── <span className="text-accent">{preview.data.folder_name}</span>
                        {preview.data.separator}
                      </p>
                      <p>
                        　　└── <span className="text-accent">{preview.data.season_folder}</span>
                        {preview.data.separator}
                      </p>
                      <p>
                        　　　　└── <span className="text-ink">{preview.data.filename}</span>
                      </p>
                    </div>
                    <p className="mt-2 break-all border-t border-border pt-2 text-muted">{preview.data.full_path}</p>
                  </div>
                ) : (
                  <div className="rounded-inset border border-dashed border-border p-4 text-sm text-muted">
                    <p>{preview.error ? "预览加载失败" : root ? "正在加载目录示例…" : "选择路径后显示目录结构"}</p>
                    {preview.error && <p className="mt-2 break-words text-[13px]">{preview.error.message}</p>}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </section>
        <div className="grid min-w-0 gap-6 lg:grid-rows-[1fr_auto]">
          <TmdbSettingsSection />
          <Card>
            <CardHeader className="flex-wrap items-center border-b-0">
              <div>
                <CardTitle>登录会话</CardTitle>
                <CardDescription>退出当前账户，之后需要重新登录。</CardDescription>
              </div>
              <Button
                variant="danger"
                icon={LogOut}
                pending={logout.isPending}
                pendingLabel="退出中…"
                onClick={() => logout.mutate()}
              >
                退出登录
              </Button>
            </CardHeader>
          </Card>
        </div>
      </div>
    </>
  )
}
