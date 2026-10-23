# Mooncell

面向日漫 RSS 场景的自托管自动追番工具，连接订阅源、下载器和媒体库，将下载结果整理为 Jellyfin、Plex、Emby 可识别的目录结构。

```text
RSS 订阅 → 标题与集数解析 → 下载筛选 → qBittorrent 下载 → 媒体库整理
                              ↓
                           人工审核
```

[快速启动](#快速启动) · [首次配置](#首次配置) · [使用指南](docs/USAGE.md) · [本地开发](docs/DEVELOPMENT.md)

## 功能与支持范围

| 功能 | 当前支持 |
| --- | --- |
| RSS 订阅 | Mikan / 标准 RSS / Atom，定时刷新、排除关键词、标题与集数解析 |
| 自动下载与整理 | qBittorrent 自动投递、去重、文件筛选、重命名和移动，保留做种 |
| 版本选择 | 字幕语言优先级、单集修订版择优及符合条件的旧版替换 |
| 人工审核 | 处理低置信度解析、集数修正和整理冲突，保留操作日志 |
| 元数据与图片 | TMDB 搜索、元数据与图片刮削、图片上传 |
| 追番日历 | 从 yuc.wiki 缓存季度新番，自动检查季度切换 |
| 账户 | 首次启动创建唯一管理员账户 |
| 在线播放 | 按客户端能力选择原文件直放、视频流复制或 HLS 转码，支持全片跳转、字幕、选集、续播及可选 WebGPU Anime4K 增强；见[播放说明](docs/PLAYBACK.md) |

**当前限制：** aria2 仅支持连接配置与测试；自动整理使用 `downloader_managed` 策略，暂不执行硬链接或复制。详细规则见[使用指南](docs/USAGE.md)。

## 快速启动

推荐使用 Docker Compose。前后端打包为一个 `mooncell:local` 镜像，由同一个容器提供 WebUI 和 API。以下命令均在项目根目录的 PowerShell 中执行。

### 1. 配置环境变量

```powershell
Copy-Item -LiteralPath ".env.example" -Destination ".env"
```

编辑 `.env`，将 `MOONCELL_SECRET_KEY` 替换为长随机字符串，并配置宿主机下载目录和媒体库目录。Windows 宿主机挂载路径建议使用 `D:/Downloads` 形式：

```dotenv
MOONCELL_SECRET_KEY=请替换为至少32位随机字符串
MOONCELL_DOWNLOADS_PATH=D:/Downloads/Anime
MOONCELL_LIBRARY_PATH=D:/Media/Anime
```

### 2. 构建并启动

```powershell
docker compose up -d --build
```

只构建镜像时执行 `docker build -t mooncell:local .`；构建后可用 `docker compose up -d --wait` 启动并等待健康检查通过。

### 3. 打开 WebUI

本地开发 WebUI：本机访问 <http://localhost:5173>；局域网设备访问 `http://本机局域网IP:5173`。

使用上述 Docker Compose 部署时，默认映射端口为 `3000`，访问 <http://localhost:3000> 或 `http://本机局域网IP:3000`。首次进入时创建管理员账户，然后完成下方配置。

### 数据与目录

| 宿主机位置 | Mooncell 容器内位置 | 用途 |
| --- | --- | --- |
| 项目根目录的 `data` | `/app/data` | 数据库、季度日历等持久化数据 |
| `MOONCELL_DOWNLOADS_PATH` | `/downloads` | 下载目录挂载 |
| `MOONCELL_LIBRARY_PATH` | `/library` | 媒体库目录挂载 |

Docker 镜像已内置前端产物、Python 服务、ImageMagick、FFmpeg 与 FFprobe，无需在宿主机另行安装。容器统一监听 `8000`，Compose 映射到宿主机 `3000`。更多配置见 [.env.example](.env.example) 和 [docker-compose.yml](docker-compose.yml)。

## 首次配置

1. **连接下载器**：在设置中配置并启用 qBittorrent，使用 `downloader_managed` 整理策略（界面默认值）。下载器需单独部署。
2. **选择媒体库**：在设置中选择媒体库目录；Docker 部署默认使用 `/library`。目录必须能被下载器访问，路径不同时配置下载器的本地 / 远程根目录映射。
3. **配置元数据（可选）**：在“设置 → TMDB 元数据与图片”中填写读访问令牌或 API 密钥。
4. **添加并刷新订阅**：填写 RSS 地址、季度和筛选条件。解析通过的发布会自动进入下载队列；异常条目在“审核”页处理。

后续可按需查阅：

- [订阅与刷新规则](docs/USAGE.md#订阅与刷新)
- [自动下载与文件整理](docs/USAGE.md#自动下载与文件整理)
- [人工审核](docs/USAGE.md#人工审核)
- [TMDB 配置](docs/USAGE.md#tmdb-配置)
- [季度追番日历与缓存](docs/USAGE.md#季度追番日历)

## 本地开发

Windows 开发环境可通过脚本自动安装 Python 3.12、Node.js、项目指定版本的 pnpm、FFmpeg（含 ffprobe）、ImageMagick 7，以及前后端依赖。在项目根目录执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
```

安装需要联网，缺失系统软件时使用 WinGet。支持重复运行及 `-CheckOnly` 仅检查模式，详见[开发指南](docs/DEVELOPMENT.md#自动安装推荐)。安装完成后重新打开 PowerShell，再从项目根目录启动前后端：

```powershell
& ".\scripts\dev.ps1"
```

默认 WebUI 为 <http://localhost:5173>，API 文档为 <http://localhost:8000/docs>。端口不可用时自动选择其他端口，以脚本输出为准；按 `Ctrl+C` 同时停止前后端。

开发模式默认启用演示数据，检查真实数据前请参照[演示数据说明](docs/DEVELOPMENT.md#开发演示数据)关闭。

## 技术栈与文档

- **前端**：React 19、TypeScript、Vite、Tailwind CSS、shadcn/ui 风格组件、TanStack Query。
- **后端**：Python 3.12、FastAPI、SQLAlchemy、SQLite、SSE。
- **部署**：Docker Compose。

| 文档 | 内容 |
| --- | --- |
| [使用指南](docs/USAGE.md) | 订阅、下载整理、版本选择、审核、TMDB 和日历 |
| [开发指南](docs/DEVELOPMENT.md) | 环境准备、启动、演示数据与验证命令 |
| [前端特效与交互约定](docs/FRONTEND_EFFECTS.md) | 全局和共享组件特效、生效范围、按钮规则与减少动态效果 |
| [技术设计](TECHNICAL_DESIGN.md) | 架构与自动化流水线设计（讨论稿） |
| [数据库表说明](docs/DATABASE_TABLES.md) | 数据表、字段约定与表关系 |

## 访问安全与许可

Mooncell 面向可信局域网内的单用户使用。不要直接暴露到公网；远程访问建议通过 VPN，或使用带 TLS 和额外认证的反向代理。

本项目采用 [MIT License](LICENSE)。
