/**
 * 开发阶段演示数据。
 *
 * TODO(release): 接入真实订阅、下载任务和整理任务 API 后删除整个 `src/mocks` 目录。
 * 所有消费者都必须经过 `DEMO_MODE` 判断；Vite 生产构建会把 DEV 分支裁剪掉。
 */

export type DemoShow = {
  id: string
  title: string
  originalTitle: string
  season: number
  downloaded: number
  total: number
  latestEpisode: number
  nextRelease: string
  status: "airing" | "waiting" | "completed" | "paused"
  group: string
  resolution: string
  subtitle: string
  source: string
  accent: string
  aliases: string[]
}

export type DemoDownload = {
  id: string
  showId: string
  title: string
  episode: number
  status: "downloading" | "queued" | "paused" | "completed" | "failed"
  progress: number
  speed: string
  eta: string
  size: string
  downloaderState: string
  source: string
}

export type DemoOrganizeTask = {
  id: string
  title: string
  episode: number
  status: "pending" | "processing" | "completed" | "conflict"
  sourcePath: string
  targetPath: string
  strategy: "原地重命名" | "硬链接" | "复制"
  updatedAt: string
}

export type DemoReview = {
  id: string
  reason: "低置信度" | "合集" | "路径冲突" | "Special 无编号"
  rawTitle: string
  parsedTitle: string
  confidence: number
  evidence: string[]
  warning: string
  proposedPath: string
}

export const demoShows: DemoShow[] = [
  { id: "frieren", title: "葬送的芙莉莲", originalTitle: "Sousou no Frieren", season: 2, downloaded: 7, total: 12, latestEpisode: 7, nextRelease: "周五 23:00", status: "airing", group: "ANi", resolution: "1080p", subtitle: "繁体中文", source: "Baha · WEB-DL", accent: "from-emerald-200 via-lime-100 to-sky-100", aliases: ["Frieren", "葬送的芙莉莲 第二季"] },
  { id: "apothecary", title: "药屋少女的呢喃", originalTitle: "Kusuriya no Hitorigoto", season: 2, downloaded: 18, total: 24, latestEpisode: 18, nextRelease: "周六 01:15", status: "airing", group: "喵萌奶茶屋", resolution: "1080p", subtitle: "简繁", source: "WEB-DL", accent: "from-rose-200 via-orange-100 to-amber-100", aliases: ["The Apothecary Diaries", "药师少女的独语"] },
  { id: "dandadan", title: "胆大党", originalTitle: "Dandadan", season: 2, downloaded: 10, total: 12, latestEpisode: 10, nextRelease: "周四 23:45", status: "airing", group: "LoliHouse", resolution: "1080p", subtitle: "简繁", source: "B-Global", accent: "from-violet-200 via-fuchsia-100 to-orange-100", aliases: ["超自然武装当哒当", "Dan Da Dan"] },
  { id: "orb", title: "地。—关于地球的运动—", originalTitle: "Chi. Chikyuu no Undou ni Tsuite", season: 1, downloaded: 25, total: 25, latestEpisode: 25, nextRelease: "已完结", status: "completed", group: "桜都字幕组", resolution: "1080p", subtitle: "简体中文", source: "BluRay", accent: "from-stone-300 via-amber-100 to-slate-200", aliases: ["Orb: On the Movements of the Earth"] },
  { id: "witch-hat", title: "尖帽子的魔法工房", originalTitle: "Tongari Atama no Atelier", season: 1, downloaded: 0, total: 12, latestEpisode: 0, nextRelease: "等待首播", status: "waiting", group: "ANi", resolution: "1080p", subtitle: "繁体中文", source: "Baha", accent: "from-sky-200 via-indigo-100 to-lime-100", aliases: ["Witch Hat Atelier"] },
  { id: "chainsaw", title: "链锯人 剧场版：蕾洁篇", originalTitle: "Chainsaw Man: Reze-hen", season: 0, downloaded: 0, total: 1, latestEpisode: 0, nextRelease: "等待资源", status: "paused", group: "未指定", resolution: "2160p", subtitle: "简繁", source: "BluRay", accent: "from-red-300 via-orange-100 to-zinc-200", aliases: ["Chainsaw Man Movie", "Reze Arc"] },
]

export const demoDownloads: DemoDownload[] = [
  { id: "dl-101", showId: "frieren", title: "葬送的芙莉莲", episode: 8, status: "downloading", progress: 68, speed: "8.4 MB/s", eta: "4 分钟", size: "1.42 GB", downloaderState: "downloading", source: "[ANi] 1080P Baha WEB-DL CHT" },
  { id: "dl-102", showId: "apothecary", title: "药屋少女的呢喃", episode: 19, status: "downloading", progress: 31, speed: "3.1 MB/s", eta: "11 分钟", size: "1.16 GB", downloaderState: "stalledDL", source: "[Nekomoe kissaten] 1080p CHS&CHT" },
  { id: "dl-103", showId: "dandadan", title: "胆大党", episode: 11, status: "queued", progress: 0, speed: "—", eta: "队列中", size: "982 MB", downloaderState: "queuedDL", source: "[LoliHouse] 1080p B-Global" },
  { id: "dl-104", showId: "orb", title: "地。—关于地球的运动—", episode: 25, status: "completed", progress: 100, speed: "—", eta: "已完成", size: "1.87 GB", downloaderState: "uploading", source: "[Sakurato] 1080p BluRay" },
]

export const demoOrganizeTasks: DemoOrganizeTask[] = [
  { id: "org-201", title: "地。—关于地球的运动—", episode: 25, status: "completed", sourcePath: "D:\\Downloads\\Anime\\[Sakurato] Chi. - 25.mkv", targetPath: "D:\\Media\\Anime\\地。—关于地球的运动— (2024)\\Season 01\\地。—关于地球的运动— S01E25.mkv", strategy: "硬链接", updatedAt: "今天 14:32" },
  { id: "org-202", title: "葬送的芙莉莲", episode: 8, status: "pending", sourcePath: "D:\\Downloads\\Anime\\[ANi] Sousou no Frieren - 08.mkv", targetPath: "D:\\Media\\Anime\\葬送的芙莉莲 (2023)\\Season 02\\葬送的芙莉莲 S02E08.mkv", strategy: "原地重命名", updatedAt: "等待下载完成" },
  { id: "org-203", title: "胆大党", episode: 11, status: "pending", sourcePath: "D:\\Downloads\\Anime\\[LoliHouse] Dandadan - 11.mkv", targetPath: "D:\\Media\\Anime\\胆大党 (2024)\\Season 02\\胆大党 S02E11.mkv", strategy: "硬链接", updatedAt: "等待下载" },
  { id: "org-204", title: "药屋少女的呢喃", episode: 18, status: "conflict", sourcePath: "D:\\Downloads\\Anime\\[Nekomoe] Kusuriya - 18.mkv", targetPath: "D:\\Media\\Anime\\药屋少女的呢喃 (2023)\\Season 02\\药屋少女的呢喃 S02E18.mkv", strategy: "硬链接", updatedAt: "目标文件已存在" },
]

export const demoReviews: DemoReview[] = [
  { id: "rv-301", reason: "低置信度", rawTitle: "[Lilith-Raws] Sousou no Frieren 28 [Baha][WEB-DL][1080p][AVC AAC][CHT]", parsedTitle: "葬送的芙莉莲", confidence: 0.72, evidence: ["字幕组：Lilith-Raws", "候选标题别名命中", "集数候选：28"], warning: "无法确定绝对集数 28 应映射到第二季哪一集", proposedPath: "等待修正季集后生成" },
  { id: "rv-302", reason: "合集", rawTitle: "[VCB-Studio] Kusuriya no Hitorigoto [01-24][Ma10p_1080p][x265_flac]", parsedTitle: "药屋少女的呢喃", confidence: 0.88, evidence: ["标题别名命中", "范围：01-24", "来源：BluRay"], warning: "多文件合集需要检查文件与剧集是否一一对应", proposedPath: "D:\\Media\\Anime\\药屋少女的呢喃 (2023)\\Season 01\\…" },
  { id: "rv-303", reason: "路径冲突", rawTitle: "[ANi] Dandadan - 10v2 [1080P][B-Global][CHT]", parsedTitle: "胆大党", confidence: 0.96, evidence: ["修订版本：v2", "内容身份：dandadan:S02:E10"], warning: "目标位置已存在普通版本，不允许自动覆盖", proposedPath: "D:\\Media\\Anime\\胆大党 (2024)\\Season 02\\胆大党 S02E10.mkv" },
]

export const demoLogs = [
  { time: "14:36:21", level: "info", scope: "rss.mikan", message: "刷新完成：发现 42 条，新增 3 条，重复 39 条" },
  { time: "14:36:22", level: "info", scope: "matcher", message: "葬送的芙莉莲 E08 命中订阅，等待候选窗口结束" },
  { time: "14:38:04", level: "info", scope: "downloader.qb", message: "任务已提交：葬送的芙莉莲 S02E08" },
  { time: "14:42:17", level: "warning", scope: "parser", message: "条目 rv-301 置信度 0.72，已送入审核收件箱" },
  { time: "14:45:33", level: "error", scope: "organizer", message: "药屋少女的呢喃 S02E18 目标文件已存在，停止整理" },
]

export const demoCalendar = [
  { day: "周一", date: "8/31", items: [{ title: "胆大党", episode: 11, time: "23:45", accent: "bg-violet-200" }] },
  { day: "周二", date: "9/1", items: [] },
  { day: "周三", date: "9/2", items: [{ title: "尖帽子的魔法工房", episode: 1, time: "待定", accent: "bg-sky-200" }] },
  { day: "周四", date: "9/3", items: [{ title: "胆大党", episode: 12, time: "23:45", accent: "bg-fuchsia-200" }] },
  { day: "周五", date: "9/4", items: [{ title: "葬送的芙莉莲", episode: 8, time: "23:00", accent: "bg-lime-200" }] },
  { day: "周六", date: "9/5", items: [{ title: "药屋少女的呢喃", episode: 19, time: "01:15", accent: "bg-rose-200" }] },
  { day: "周日", date: "9/6", items: [] },
]
