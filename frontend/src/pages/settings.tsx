import { SubscriptionSettingsSection } from "@/components/subscription-settings"
import { TmdbSettingsSection } from "@/components/tmdb-settings"
import { useEffect } from "react"
import { useLocation } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { ParserSettingsSection } from "@/pages/parser"
import { FolderTree } from "lucide-react"
import { api, type ParsedRelease } from "@/lib/api"
import { DownloaderSettingsSection } from "@/components/downloader-settings"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field } from "@/components/field"
import { Input } from "@/components/ui/input"
import { FolderPicker, type LibraryPath } from "@/components/folder-picker"
import { PageHeading } from "@/components/page-heading"

type Preview = { parsed: ParsedRelease; directory: string; filename: string; full_path: string; library_root: string; folder_name: string; season_folder: string; separator: string }

/** 集中管理下载器连接，以及媒体库目录和文件命名。 */
export function SettingsPage() {
  const { hash } = useLocation()
  useEffect(() => {
    if (hash === "#parser") document.getElementById("parser")?.scrollIntoView()
  }, [hash])
  const library = useQuery({ queryKey: ["library-settings"], queryFn: () => api<LibraryPath>("/settings/library") })
  const root = library.data?.library_root ?? ""
  const preview = useQuery({
    queryKey: ["path-preview", root],
    queryFn: () => api<Preview>("/setup/path-preview", { method: "POST", body: JSON.stringify({ library_root: root }) }),
    enabled: Boolean(root),
  })
  return <>
    <PageHeading eyebrow="Configuration" title="设置" description="集中管理下载器连接、TMDB、保存路径和标题解析。"/>
    <div className="grid gap-6">
      <DownloaderSettingsSection/>
      <SubscriptionSettingsSection/>
      <TmdbSettingsSection/>
      <section aria-label="保存路径">
        <Card>
          <CardHeader><div><CardTitle>保存路径</CardTitle><CardDescription>选择媒体库根目录，预览最终目录与文件名。</CardDescription></div><FolderTree size={20} className="text-[var(--muted)]"/></CardHeader>
          <CardContent className="grid items-start gap-5 lg:grid-cols-2">
            <div className="min-w-0">
              <Field label="媒体库根目录">
                <div className="flex flex-wrap items-center gap-2"><Input className="min-w-0 flex-1 basis-48" value={root} readOnly placeholder={library.isPending ? "正在读取保存路径…" : "请选择文件夹"}/><FolderPicker value={root} onSaved={() => {}}/></div>
                {library.error && <p role="alert" className="mt-1 text-xs text-[var(--danger)]">{library.error.message}</p>}
              </Field>
              <p className="mt-3 text-[13px] leading-6 text-[var(--muted)]">选择后自动保存。目录结构兼容 Plex、Jellyfin 与 Emby。</p>
            </div>
            <div className="min-w-0">
              <p className="mb-2 text-sm font-medium text-[var(--ink)]">目录预览</p>
              {preview.data ? <div className="rounded-[2px] bg-[var(--surface)]/20 p-3 font-mono text-xs leading-6 text-[var(--ink)] ring-1 ring-[var(--border)]">
                <div className="whitespace-normal break-all">
                  <p>{preview.data.library_root}{preview.data.library_root.endsWith(preview.data.separator) ? "" : preview.data.separator}</p>
                  <p>└── <span className="text-[var(--accent)]">{preview.data.folder_name}</span>{preview.data.separator}</p>
                  <p>　　└── <span className="text-[var(--accent)]">{preview.data.season_folder}</span>{preview.data.separator}</p>
                  <p>　　　　└── <span className="text-[var(--ink)]">{preview.data.filename}</span></p>
                </div>
                <p className="mt-2 break-all border-t border-[var(--border)] pt-2 text-[var(--muted)]">{preview.data.full_path}</p>
              </div> : <div className="rounded-[2px] border border-dashed border-[var(--border)] p-4 text-sm text-[var(--muted)]"><p>{preview.error ? "预览加载失败" : root ? "正在加载目录示例…" : "选择路径后显示目录结构"}</p>{preview.error && <p className="mt-2 break-words text-[13px]">{preview.error.message}</p>}</div>}
            </div>
          </CardContent>
        </Card>
      </section>
      <section id="parser" className="grid scroll-mt-6 gap-4"><ParserSettingsSection/></section>
    </div>
  </>
}
