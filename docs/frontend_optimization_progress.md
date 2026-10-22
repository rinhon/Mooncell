# 前端优化执行记录

> 当前状态（2026-10-22）：P0–P7 代码实施完成。首批 P0/P1 记录保留于下文，后续实施与验收见「P2–P7」章节。集显实机的呈现帧率和 GPU 占用仍待人工验收。

## 2026-10-22：P0 工具与基线、P1 快速修复

对应 [开发计划](frontend_optimization_plan.md)。本轮在现有未提交的 Staggered 抽屉导航基础上开发，保留已有工作；P2–P7 尚未实施。

### P0 基线

- 原始生产构建日志：`.cache\perf\baseline-bundle.txt`；冻结产物：`.cache\perf\baseline-dist\`。
- 新增 `scripts\visual-check.cjs`：9 个计划路由与番剧详情页，375 / 768 / 1280 / 1440 四种宽度，两套主题；另测 iPhone 13 登录与初始化，共 84 个场景。使用固定的 36 部番剧、40 条日历数据与本地图像夹具，不依赖真实后端数据。
- 截图同时断言非空内容、页面与控件横向溢出、78px 顶栏、品牌与工具重叠、破损图片、脚本异常和遗漏的模拟接口。失败会保留截图并以非零状态退出。
- P0 截图与报告：`.cache\visual\p0\`。76 个场景通过，8 个 `/organizer` 场景失败：原始生产页只有标题和说明，没有真实内容；这正是 P1 要移除的演示入口。全部 84 场景无横向溢出、脚本异常或破损图片。
- iPhone 13（390×664）两主题登录/初始化均无溢出：卡片左侧 16px、宽 358px、右侧 374px。未触发计划中的登录布局修复条件。
- 新增 `scripts\frontend-perf.cjs`：36 部番剧的卡片页匀速滚动 5 秒、日历切换星期 5 秒、首页静置 10 秒，分别采集 1920×1080 和 3840×2160；保存 rAF 帧间隔、主线程长任务与可导入 DevTools 的 CDP trace。

| 合成基线场景 | 1920×1080 rAF/秒 | 3840×2160 rAF/秒 | >50ms 长任务 |
| :--- | ---: | ---: | ---: |
| 番剧滚动 | 119.09 | 120.12 | 0 / 0 |
| 日历切换 | 120.02 | 120.20 | 0 / 0 |
| 首页静置 | 120.02 | 120.06 | 0 / 0 |

采集环境为 Windows、Edge 155 无头模式、RTX 4070 SUPER、DPR=1。rAF 频率不等于显示器实际呈现帧率，当前机器的结果不能作为集显验收或性能提升证据；GPU 利用率未测量。集显实机的 FPS / GPU 占用验收仍待后续完成。原始数据及六份 trace 位于 `.cache\perf\p0-render.json` 和 `.cache\perf\p0-*-trace.json.gz`。

### P1 实现

1. 深海蓝主题采用候选 A：正文 `#1d2433`、次级文字 `#424b5c`、辅助文字 `#606978`；强调色保留 `#122e8a`。已对比设置与番剧页、375 / 1440 宽度的两套候选截图。四种主要背景上的正文对比度最低 12.69:1，强调色最低 9.62:1，辅助文字最低 4.53:1。计算结果：`.cache\perf\p1-theme-contrast.json`。
2. 主导航移除「整理」；仅开发演示模式加载整理页，生产访问 `/organizer` 重定向 `/downloads`，生产构建不再生成 organizer chunk。
3. 番剧页移除整批图片预加载门槛；日历移除整组封面的隐藏逻辑。共用 `FadeInImage`，保留固定图片槽、逐张淡入、日历单图骨架与加载失败占位；首图优先加载，其余按需懒加载。
4. 滚动恢复在数据布局提交后执行，清理取消的 rAF，兼容 StrictMode；固定卡片 Logo 槽。
5. 首页画廊在悬停、获得焦点或页面隐藏时暂停，恢复时继续剩余倒计时。移除悬停立即切换，保留点击与键盘操作。
6. 含内部控件的番剧卡片取消上浮，保留边框反馈；整块链接的海报保留原有反馈。
7. 视图偏好按有效返回状态 → `localStorage("mooncell-shows-view")` → 卡片恢复；读写存储异常均可容错。
8. 通过 pnpm 移除无引用的 `@base-ui/react`，同步锁文件，共清理五个不再需要的包。

### 验证与产物

- `pnpm --dir frontend lint`：通过。
- `pnpm --dir frontend test:player`：39 / 39 通过。
- `pnpm --dir frontend build`：通过。大型播放器相关 chunk 的既有构建提示仍保留，按计划在后续性能阶段处理。
- 生产入口 JS gzip：70,151 → 70,007 字节（减少 144 字节）。全部 JS / CSS 文件 gzip 求和减少 1,935 字节；该数值不是首屏传输量。详细比较：`.cache\perf\bundle-comparison.json`。
- P1 普通动效视觉矩阵：84 / 84 通过，截图及报告位于 `.cache\visual\p1\`。另复用已有开发服务验证演示模式 `/organizer` 仍可访问，报告位于 `.cache\visual\p1-demo\report.json`。
- 新增 `scripts\frontend-p1-check.cjs`：10 / 10 行为回归通过，覆盖图片请求挂起时 36 张番剧卡片与 5 张当日日历卡片即已渲染、封面解码失败占位、视图持久化、详情链接返回与浏览器后退恢复筛选/视图/滚动、存储禁用容错、卡片悬停无位移、画廊悬停/焦点暂停与键盘、生产演示页跳转、减少动态效果下图片立即显示。报告位于 `.cache\frontend-p1-check\result.json`。
- 减少动态效果视觉矩阵：84 / 84 通过，报告位于 `.cache\visual\p1-reduced\report.json`；捕获前等待真实业务内容和首屏图片完成加载/解码，避免误拍骨架。初次调试验证器时的骨架截图保留于 `.cache\visual\p1-reduced-initial-wait\`，不作为验收结果。
- 已查看主题候选对比、桌面番剧卡片、移动日历及减少动态效果的首页截图，文字、固定图片槽与操作控件布局正常。新脚本语法检查和 `git diff --check` 均通过。

### 复测命令

所有命令从 `F:\code\mooncell` 执行。浏览器脚本优先使用 `PLAYWRIGHT_PATH` 指定的 Playwright，其次使用已安装的包或 Codex 本机运行时；默认启动 Edge。截图与报告只写入项目 `.cache\`。

```powershell
pnpm --dir frontend lint
pnpm --dir frontend test:player
pnpm --dir frontend build

# 独立终端启动构建产物预览；不启动或变更真实后端。
pnpm --dir frontend exec vite preview --host 127.0.0.1 --port 4174 --strictPort

node scripts\visual-check.cjs --stage p1 --base-url http://127.0.0.1:4174
node scripts\visual-check.cjs --stage p1-reduced --base-url http://127.0.0.1:4174 --reduced-motion
node scripts\frontend-p1-check.cjs --base-url http://127.0.0.1:4174

# 后续性能阶段复用同一场景，避免与构建和截图并行运行。
node scripts\frontend-perf.cjs --stage p5 --base-url http://127.0.0.1:4174
```

如需启动完整开发环境，继续使用工作区约定的固定入口：

```powershell
powershell.exe -NoProfile -File F:\code\mooncell\scripts\dev.ps1
```

本机 nvm 未配置活动 Node 版本，因此本轮检查使用 Codex 已安装的 Node / pnpm；pnpm 路径解析和 Edge 命名管道在沙箱内受限，相关检查经正式 `require_escalated` 流程运行。没有更改全局沙箱、系统 ACL 或开发启动入口。

### 首批结束时的下一阶段

P2：Tailwind 令牌映射、集中 Spring 预设与设计规范。P3–P7 的导航、首页画廊、全局背景等开放选项仍见原计划，未提前替用户作出产品取舍。

## 2026-10-22：P2–P7 后续实施

本轮接续现有未提交的 P0/P1 与 Staggered 导航成果；未调用 DevSpace，未创建提交。按计划的总体目标采用桌面常驻导航、删除首页画廊、静态 CSS 背景、删除特效光标与彩纸、移除装饰英文和启用 Prettier。

### P2 设计系统

- `index.css` 增加颜色与 12 / 13 / 14px 字号的 `@theme inline` 映射，保留运行时双主题；显式生成三个字号工具类。
- 新增 `frontend\src\lib\motion.ts`，集中 `snappy` / `gentle` / `layout` / `press` Spring。
- 新增 `docs\design-system.md`，约定颜色、文字、圆角、模糊、动效与键盘交互。
- `cn` 为自定义字号与圆角扩展 tailwind-merge 分组，避免同组类名不能互相覆盖。
- 两主题均通过实际 DOM computed style 检查：颜色、背景、边框与运行时变量一致，控件圆角 8px，字号分别为 12 / 13 / 14px。

### P3 导航

- 新增 `TopNav`，≥1024px 常驻显示首页、番剧、订阅、下载、日历，详情子路由高亮番剧；活动与悬停指示器使用统一 Spring。
- 主导航与窄屏抽屉共用 `lib\navigation.ts`。通过 `useOverflowMenu` 把末尾溢出项放进「更多」，与审核、日志、设置合并；显示 `/dashboard.needs_review` 数量。
- 1024 / 1280 / 1440 / 1920px 均通过无重叠、无横向溢出检查。Tab 顺序、更多菜单方向键、Esc 焦点恢复、跨断点关闭和移动抽屉均有浏览器回归。
- 可选 `G` 连按快捷键未实施，保留现有键盘导航。

### P4 首页 V2

- 首页替换为四项指标、今日放送、下载前三项与总速度、最新发布、最近添加番剧。保留无订阅引导，各模块独立骨架与错误重试。
- 复用 dashboard / downloads / shows / notifications / season-calendar 查询缓存；下载仅页面可见时每 5 秒刷新。日历按喜欢优先、放送时间排序，当日链接可直接选中对应星期。
- 指标使用 Spring 数字，减少动态效果直接显示终值。四张卡均可键盘操作，提醒卡打开现有通知中心，关闭后恢复实际入口焦点。
- 真实接口与原计划有两处差异：提醒摘要只有 `unread_count` / `active_count`，因此准确标记为「后台提醒」；最新发布不保证有 `source_id`，优先经下载任务 ID 关联，其次唯一标题匹配，无法确认则跳番剧搜索。未修改后端。
- 五个接口分别返回 500 时，其余模块正常；挂起 shows 请求时，其他有意义内容在本机模拟环境中 **428ms** 出现。该值不是真实网络环境承诺。

### P5 特效与性能

- 工作区改为静态 CSS 渐变，移除 Grainient / ogl。海报与卡片的 GradualBlur 换为 `.media-scrim`；普通卡片、搜索栏和日历移除背景模糊。固定顶栏保留 3 层模糊，视口底部装饰删除，日志上下边缘使用纯渐变。
- 删除 AccordionGallery、TargetCursor、Confetti、SpecularButton 及其无引用资源。StrokeText 迁移到 Motion，清除最后的 gsap 引用；移除 gsap、ogl、canvas-confetti、@types/canvas-confetti 并同步 pnpm 锁文件。
- AuthScreen 与 GridMotion 按需加载。登录的 GridMotion 在减少动态效果下直接显示静态终态并停止持续 rAF；其他模式继续保留登录背景。
- BlurFade 删除模糊滤镜并使用 Spring；FadeInImage、公共浮层、按钮、进度、品牌、视图切换及详情工作区使用集中预设。
- 新增 `PageMotionContext`，会话内复访不重复页面与逐项入场；品牌只在会话首次自动播放，保留主动悬停反馈。

| gzip 按文件计算 | P0 基线（字节） | 最终（字节） | 变化 |
| :--- | ---: | ---: | ---: |
| 入口 JS | 70,151 | 65,873 | -4,278（-6.10%） |
| 入口 JS 及其静态 JS 依赖 | 268,803 | 206,335 | -62,468（-23.24%） |
| 全部 JS / CSS 文件求和 | 1,524,290 | 1,450,436 | -73,854（-4.85%） |

静态依赖集合不含路由懒加载，不等同浏览器实际首屏传输量。日志位于 `.cache\perf\final-bundle.txt`，逐文件明细与依赖集合见 `.cache\perf\final-bundle-comparison.json`；通过 `scripts\frontend-bundle-report.cjs` 重算。播放器与 Anime4K 的既有大 chunk 提示仍存在，未放宽警告阈值。

### P6 交互

- 详情海报不再隐式编辑；「更换图片」进入作品菜单，标题区域直接展示播放 / 继续观看与打开文件夹。播放链接明确携带 `autoPlay: true`。
- 移除 Feed 容器无动作的 Tab 焦点。RSS/TMDB 候选区域使用具名分组，按钮名称明确包含标题、媒体类型与 ID，避免外层 label 覆盖候选可访问名称。
- 错误 Toast 不自动关闭，成功 Toast 保留自动关闭。错误提示在 4.2 秒后仍可读并可手动关闭，已有滑动反馈保留。
- 页面标题移除装饰英文；所有原 8–11px 字号提升至至少 12px，日历喜欢与详情新增标记使用语义或中性色。P0 已证实移动认证无溢出，因此未额外改变认证卡片布局。
- 拆分后补齐 RSS 保存保护：保存中阻止关闭、取消、切标签并防重复提交；为 RSS 解析、TMDB 搜索与详情增加请求版本校验，避免旧结果覆盖新选择，提交时校验候选身份与元数据一致。

### P7 结构与格式

- 订阅拆出 AddSubscriptionDialog、RssSubscriptionForm、TmdbCandidateList、FeedCard、DeleteFeedDialog。
- 番剧拆出 ShowCard、ShowPosterTile、ShowRow、ShowActionsMenu 与共用元数据；详情拆出 DetailHeader、DetailActions、SubscriptionInfoPanel；日历拆出 CalendarItemCard、星期标签与 useCalendarFavorite。
- 新增 `scripts\frontend-token-migrate.cjs`：只替换 `@theme inline` 白名单颜色与已定义圆角，默认 dry run，`--write` 才写入。第二次执行无改动。
- Prettier 已作为前端开发依赖锁定，`printWidth: 120`，加入 `format` / `format:check`。长 class 字符串分段，`frontend\src` 的 TS / TSX / CSS 单行长度全部 ≤160。
- `rounded-[var(`、`text-[var(--`、TSX 十六进制颜色与 CSS 小于 12px 固定字号均为 0。
- 本轮未创建 Git 提交，因此未向 `.git-blame-ignore-revs` 写入虚构提交哈希；后续若单独提交格式化，可再登记实际哈希。

### 验证与产物

- 类型检查、39 / 39 播放器测试、格式检查、生产构建与脚本语法检查通过。
- `scripts\frontend-optimization-check.cjs`：23 / 23 通过，报告 `.cache\frontend-optimization-check\result.json`。
- `scripts\frontend-subscription-check.cjs`：3 / 3 通过，覆盖同一轮连续提交仅一次 POST、保存时关闭保护、RSS URL 旧响应、TMDB 详情乱序及提交身份。报告 `.cache\frontend-subscription-check\result.json`。
- 更新 P1 检查以适配首页和导航新结构，10 / 10 通过，仍覆盖慢图、失败图、视图偏好与滚动恢复。
- P7 迁移对比：`.cache\visual\p7-before-tokens\` 与 `p7-after-tokens\`。80 张应用页面截图经 ImageMagick AE 比较，**差异像素全部为 0**；报告 `p7-after-tokens\comparison.json`。认证四张另有 GridMotion 减少动态效果修复，不纳入零差异声明，布局检查仍全部通过。
- 迁移中曾发现圆角优先级使番剧卡片实际 12px 变成 16px，已恢复为规范的 `rounded-card`；未放宽截图阈值。
- 最终普通动效 `.cache\visual\final\` 与减少动态效果 `.cache\visual\final-reduced\` 各 **84 / 84** 通过。已查看 1440px 深海蓝首页与 375px 森林详情，确认四指标与今日放送一屏可见、播放与文件夹入口清晰。
- 最后对照后端 `progress=round(progress * 100, 2)` 修正夹具的下载百分比单位，并移除夹具中真实 recent_items 未承诺的 source_id；生产组件本来已按 0–100 处理，无需修改。新增 69 / 57 / 45% 语义进度断言，23 项优化回归再次全部通过；首页、下载与整理重定向另补 24 / 24 截图，报告 `.cache\visual\final-progress-fixture\report.json`。P7 零差异比较两侧保留同一旧夹具，未改写原图。

### P5 合成性能复测与剩余验收

性能复测在构建、行为测试和截图结束后单独执行，沿用 P0 的 36 部番剧卡片匀速滚动 5 秒、日历星期切换 5 秒、首页静置 10 秒，以及 1920×1080 / 3840×2160、DPR=1 的场景。

| 场景 | P0 1080p rAF/秒 | P5 1080p rAF/秒 | P0 4K rAF/秒 | P5 4K rAF/秒 | P5 >50ms 长任务 |
| :--- | ---: | ---: | ---: | ---: | ---: |
| 番剧滚动 | 119.09 | 120.12 | 120.12 | 120.27 | 0 / 0 |
| 日历切换 | 120.02 | 120.18 | 120.20 | 120.32 | 0 / 0 |
| 首页静置 | 120.02 | 120.13 | 120.06 | 120.17 | 0 / 0 |

六个场景均无脚本异常、未模拟接口或 trace 错误。完整结果 `.cache\perf\p5-render.json`，六份 trace 为 `.cache\perf\p5-*-trace.json.gz`。

采集仍为 Windows / Edge 155 无头浏览器 / RTX 4070 SUPER。P0 已无长任务且接近 rAF 频率上限，因此这些结果只能说明本机合成场景未回归，**不能宣称实际帧率显著提升、GPU 占用下降或集显验收通过**。最终夹具只纠正下载百分比单位，番剧数量、视口、交互时长与采样方式保持一致。

P2–P7 的代码和自动化验收已完成；唯一剩余的强制验收是借助集显实机，在 1080p / 4K 下按 P0 方法测量真实呈现 FPS 与 GPU 占用。可选快捷键未实施；格式化提交及其 blame-ignore 哈希未创建。没有把硬件条件缺失记作已通过。

### 后续复测入口

```powershell
pnpm --dir frontend lint
pnpm --dir frontend test:player
pnpm --dir frontend format:check
pnpm --dir frontend build

# 生产预览另开终端；不启动真实后端。
pnpm --dir frontend exec vite preview --host 127.0.0.1 --port 4174 --strictPort

node scripts\frontend-optimization-check.cjs --base-url http://127.0.0.1:4174
node scripts\frontend-subscription-check.cjs --base-url http://127.0.0.1:4174
node scripts\frontend-p1-check.cjs --base-url http://127.0.0.1:4174
node scripts\visual-check.cjs --stage final --base-url http://127.0.0.1:4174
node scripts\visual-check.cjs --stage final-reduced --base-url http://127.0.0.1:4174 --reduced-motion
node scripts\frontend-bundle-report.cjs
node scripts\frontend-perf.cjs --stage p5 --base-url http://127.0.0.1:4174

# 若要复核已保存的迁移截图（不重写图片）。
node scripts\frontend-visual-compare.cjs p7-before-tokens p7-after-tokens --skip-auth
```

pnpm 目录解析与 Edge 命名管道仍需要沙箱外正式授权，本轮按 `require_escalated` 运行检查；依赖清理复用现有 `F:\code\mooncell\.pnpm-store`。未更改系统 ACL、全局沙箱或完整开发启动脚本，也未把构建预览报告为完整开发环境启动。
