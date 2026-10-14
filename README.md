# Mooncell

Mooncell 是一个面向日漫 RSS 场景的自托管自动追番工具：持续发现发布、解析番剧与集数、连接 qBittorrent / aria2，并逐步把下载结果整理为 Jellyfin、Plex、Emby 能直接识别的媒体库结构。

> 当前已支持账户、RSS 刷新、标题解析、下载器配置、媒体库路径预览，以及 qBittorrent 自动投递和文件整理。

## 订阅自动下载

订阅卡片的“编辑”按钮或右键菜单可修改番剧名称、RSS 地址、排除关键词、季度、类型、启用状态和刷新间隔。保存后保留已有下载、文件及 TMDB 关联；排除关键词用于后续发布筛选。各订阅采用自身刷新间隔，修改设置页的全局刷新间隔会统一覆盖已有订阅。

启用 qBittorrent 下载器并使用 `downloader_managed` 策略（界面默认值），在设置中选择媒体库目录。手动或定时刷新订阅后，解析通过的条目自动进入持久化下载队列；已有条目也会补投，重复刷新不会重复添加相同 info-hash。aria2 当前仍只支持连接配置和测试。

磁力链接先在媒体库 `.mooncell/<info-hash>` 下获取元数据，后台读取真实文件列表后整理：

- 无外层文件夹：保存至 `番名/Season 02/番名 S02E05.mkv`。
- 有共同外层文件夹：将外层改为 `Season 02`，放入番名目录，视频按相同规则命名。
- 季度优先采用订阅填写值；多视频逐文件识别集数，保留原视频扩展名。
- 同一集的语言版本按“简中独立版 → 简繁内封版 → 繁中独立版”选择，不同时下载多个语言版本；识别文件名及目录中的 CHS/CHT、GB/BIG5、简中/繁中、zh-Hans/zh-Hant、简繁内封等标记。低优先级版本设为“不下载”并跳过重命名；只有繁中时正常下载繁中。

新任务在磁力元数据获取后暂停，确认文件筛选和目录整理完成后才开始下载。旧版下载器若不支持元数据自动暂停，会在后台首次读取到文件列表时暂停；已经下载的文件不会被删除。

重命名和移动通过 qBittorrent Web API 执行，不破坏做种。后台每 5 秒继续处理，等待元数据、服务重启或临时接口失败后可继续；下载中心显示自动化状态和异常原因。低置信度条目、无法识别集数和不符合修订版升级条件的同集冲突需人工审核。不会接管用户已在其他目录手工添加的相同种子。

支持 `[01]`、`[01v2]` 等方括号集数。对同一订阅内作品、季度、集数、字幕组、分辨率及字幕语言/封装规格一致的单集发布，首次刷新只投递最高修订号，不依赖 RSS 顺序或发布时间；旧记录显示“已被新版取代”，后续刷新不会再次投递。缺少可靠身份信息时仍需审核。

已有系统管理的旧版入库后出现更高修订版，新版先在 `.mooncell/<新 info-hash>` 独立下载。qBittorrent 确认所选文件完整且未处于校验/异常状态后，暂停旧种子并将旧文件移动到独立备份目录，再把新版移入媒体库。确认新版入库后才删除备份目录中的旧种子和旧文件；提升新版失败会恢复旧版，保留新版暂存文件并进入审核。各阶段持久化保存，服务重启可继续；合集、跨订阅、规格不同、目录被手动改变或多个任务共享文件时不自动替换。

媒体库目录必须能被下载器访问；容器路径不同时配置下载器的本地/远程根目录映射，媒体库需在映射范围内。当前自动整理不执行硬链接或复制策略。

## 人工审核

“审核”页读取真实待审核发布和下载整理异常，支持搜索、重新解析、忽略及修正批准。
可修正媒体库番名、季度和集数（特别篇可使用季度 0）；修正仅对该发布生效。
合集或无法识别文件集数的任务，在获取种子元数据后可逐文件填写集数或选择跳过。
批准会继续下载队列，但仍检查目标文件冲突；不会覆盖已有同名文件。
忽略会暂停已有任务并保留文件，后续订阅刷新不会重复投递该条目。
重新解析只更新证据，仍需明确批准。操作和批准前后的解析信息保存到事件日志。

## TMDB 配置

在“设置 → TMDB 元数据与图片”中填写 TMDB API 读访问令牌或 API 密钥，任选其一；同时配置时优先使用读访问令牌。凭据可在 [TMDB 账户 API 设置](https://www.themoviedb.org/settings/api) 中获取，保存后立即用于后续请求。

搜索、作品详情和图片列表均通过官方 v3 API 获取。凭据在数据库中加密保存，设置页面仅显示配置状态；输入留空保留原值，勾选清除后保存可移除对应凭据。加密沿用应用的 `MOONCELL_SECRET_KEY`。

已有订阅不会自动重抓：在番剧页点击“重新刮削”即可更新元数据和图片。总集数使用电视详情的 `number_of_episodes`，表示作品总集数，不按订阅季度筛选。首次运行新版本时会自动创建 TMDB 配置表。

## 技术栈

- 前端：React 19、TypeScript、Vite、Tailwind CSS、shadcn/ui 风格组件、TanStack Query
- 后端：Python 3.12、FastAPI、SQLAlchemy、SQLite、SSE
- 集成：Mikan / 标准 RSS/Atom、qBittorrent Web API、aria2 JSON-RPC
- 部署：Docker Compose，MIT License

## Docker 启动（推荐）

1. 复制环境变量文件：

   ```powershell
   Copy-Item -LiteralPath ".env.example" -Destination ".env"
   ```

2. 编辑 `.env`，至少把 `MOONCELL_SECRET_KEY` 改为长随机字符串。Windows 宿主机目录建议写成 `D:/Downloads` 形式：

   ```dotenv
   MOONCELL_SECRET_KEY=请替换为至少32位随机字符串
   MOONCELL_DOWNLOADS_PATH=D:/Downloads/Anime
   MOONCELL_LIBRARY_PATH=D:/Media/Anime
   ```

3. 构建并启动：

   ```powershell
   docker compose up -d --build
   ```

4. 在本机打开 `http://localhost:3000`；局域网设备使用 `http://本机局域网IP:3000`。首次进入会创建唯一管理员账户。

## Windows 本地开发

完成一次依赖安装后，可在项目根目录一键启动前后端：

```powershell
& ".\scripts\dev.ps1"
```

WebUI 默认位于 `http://localhost:5173`，API 文档默认位于 `http://localhost:8000/docs`。如果端口被占用或被 Windows 保留，脚本会自动选择其他端口并在窗口中显示实际地址。前后端运行于独立隐藏控制台，避免 Windows 后端重载信号中断启动脚本；日志同步显示在当前窗口，并保存在脚本输出的 `.cache\dev\<运行 ID>` 目录。后端仅监听 `backend\app`，修改测试文件不会重载，连续修改以 1 秒间隔检测。按 `Ctrl+C` 可同时停止前后端。

首次运行需要分别安装依赖：

后端：

```powershell
Set-Location "F:\code\mooncell\backend"
& "C:\Users\13691\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" -m venv ".venv"
& ".\.venv\Scripts\python.exe" -m pip install -e ".[dev]"
& ".\.venv\Scripts\python.exe" -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

前端另开一个 PowerShell：

```powershell
Set-Location "F:\code\mooncell\frontend"
& "C:\Users\13691\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd" install
& "C:\Users\13691\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd" dev --host 0.0.0.0
```

### 开发演示数据

开发服务器默认加载 `frontend\src\mocks\demo-data.ts` 中的演示数据，相关页面会显示“开发演示数据”标记；审核页始终读取真实 API。需要检查其他页面的真实空状态时，在 `frontend\.env.local` 设置：

```dotenv
VITE_DEMO_DATA=false
```

演示数据通过 `import.meta.env.DEV` 动态加载，生产构建不会包含对应数据模块。正式 API 覆盖这些页面后，应按文件内的 `TODO(release)` 删除整个 `frontend\src\mocks` 目录。

## 季度追番日历

追番日历从 yuc.wiki 获取季度新番，按北京时间将当前月份映射到
`YYYY01`、`YYYY04`、`YYYY07`、`YYYY10`。例如 2026 年 9 月读取 `202607`，
10 月 1 日起读取 `202610`。后端运行期间自动检查季度切换；停机错过节点时，
下次启动会补抓当前季度。源站暂不可用或尚未发布时，15 分钟后重试。
页面和封面请求默认使用环境代理；HTTPS 证书校验失败时会保留证书校验，
自动尝试直连一次。如果仍然失败，请检查系统时间及源站、代理证书；
重启后端可清除失败后的 15 分钟等待并立即重试。

番名、星期、播出时间保存到 `backend/data/calendar/YYYYMM/season.json`，
封面保存在同目录；Docker 中随 `/app/data` 数据卷持久化。
可通过 `MOONCELL_CALENDAR_CACHE_PATH` 修改缓存目录。
每个季度成功保存后不再抓取页面，失败的封面单独重试下载；浏览日历只读取本地缓存。
上一季度按钮首次访问尚未缓存的季度时会抓取并保存该季度。
时间保留源站原文，包括表示次日凌晨的 `24:00`、`25:00` 等写法。

## 验证

Windows 开发启动与热更新的隔离回归测试（使用独立测试服务，不连接项目数据库或下载器）：

```powershell
& ".\scripts\test-dev-reload.ps1"
```

```powershell
Set-Location "F:\code\mooncell\backend"
& ".\.venv\Scripts\python.exe" -m pytest
& ".\.venv\Scripts\python.exe" -m ruff check app tests

Set-Location "F:\code\mooncell\frontend"
& "C:\Users\13691\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd" run build
```

## 文档

- [产品范围与功能勾选](PRODUCT_PLAN.md)
- [技术设计](TECHNICAL_DESIGN.md)
- [数据库表说明](docs/DATABASE_TABLES.md)

## 安全提醒

Mooncell 设计为可信局域网内的单用户服务。不要直接暴露到公网；如需远程访问，建议通过 VPN 或带 TLS 和额外认证的反向代理。
