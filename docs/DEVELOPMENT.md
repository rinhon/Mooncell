# Mooncell 开发指南

[返回 README](../README.md) · [使用指南](USAGE.md)

以下命令使用 Windows PowerShell；除特别说明外，均从项目根目录执行。

## 环境准备

- Python 3.12，以下命令使用 Windows Python 启动器 `py`。
- Node.js（Docker 构建使用 Node.js 22）与 pnpm；pnpm 版本见 [frontend/package.json](../frontend/package.json) 的 `packageManager` 字段。
- ImageMagick 7，用于图片上传转码和 Clearlogo 明暗分析。

### 安装 ImageMagick

Windows 可通过 winget 安装，其他方式参见 [ImageMagick 官方下载页](https://imagemagick.org/download/)：

```powershell
winget install --id ImageMagick.Q16-HDRI --exact --source winget
```

安装后重新打开 PowerShell，确认命令可用：

```powershell
magick -version
```

如果 Mooncell 已在运行，请在新终端中重新启动，使后端读取更新后的 PATH。Docker 镜像已内置 ImageMagick，无需在宿主机另行安装。

### 安装项目依赖

```powershell
py -3.12 -m venv ".\backend\.venv"
& ".\backend\.venv\Scripts\python.exe" -m pip install -e ".\backend[dev]"
pnpm --dir ".\frontend" install
```

## 启动开发服务

### 一键启动（推荐）

依赖安装完成后，在项目根目录执行：

```powershell
& ".\scripts\dev.ps1"
```

| 服务 | 默认地址 |
| --- | --- |
| WebUI | <http://localhost:5173> |
| API 文档 | <http://localhost:8000/docs> |

- 端口被占用或被 Windows 保留时，脚本自动选择其他端口，并输出实际地址。
- 前后端运行于独立隐藏控制台，避免 Windows 后端重载信号中断启动脚本。
- 日志同步显示在当前窗口，并保存在脚本输出的 `.cache\dev\<运行 ID>` 目录。
- 后端仅监听 `backend\app`，修改测试文件不会重载；连续修改以 1 秒间隔检测。
- 按 `Ctrl+C` 同时停止前后端。
- 前端直接通过 Node.js 运行本地安装的 Vite，避免 pnpm 在启动阶段下载或切换自身版本；安装依赖仍使用 pnpm。
- 脚本最多等待 60 秒，只有后端健康接口和前端首页都返回 HTTP 200 才显示启动成功；超时或进程退出会输出错误并清理服务。

### Codex Windows 沙箱与启动授权

沙箱曾出现前端 `realpath EPERM` 和后端热重载子进程命名管道 `WinError 2`。这些问题涉及沙箱的路径访问和进程通信；一次在沙箱外运行成功不会改变后续沙箱内命令的权限。项目标记为 trusted 也不等于关闭沙箱。

在本机通过 Codex 启动时，固定使用以下入口，并通过 Codex 正式审批流程申请此命令的沙箱外运行权限：

```powershell
powershell.exe -NoProfile -File F:\code\mooncell\scripts\dev.ps1
```

需要减少重复审批时，在审批界面保存仅包含该启动入口的规则。已有 `npm run build`、pytest 或 Vite `preview` 规则不会覆盖这个命令；只批准当前一次也不会新增持久规则。脚本路径变化后需要重新授权。该例外允许启动脚本及其子进程在沙箱外执行，不会修复或关闭全局沙箱。

### 分别启动

需要单独调试服务时，可在两个 PowerShell 窗口中分别启动。两个窗口均从项目根目录开始。

后端：

```powershell
Set-Location ".\backend"
& ".\.venv\Scripts\python.exe" -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

前端：

```powershell
Set-Location ".\frontend"
pnpm dev --host 0.0.0.0
```

## 开发演示数据

开发服务器默认加载 `frontend\src\mocks\demo-data.ts` 中的演示数据，相关页面显示“开发演示数据”标记；审核页始终读取真实 API。

检查其他页面的真实数据或空状态时，在 `frontend\.env.local` 设置并重启前端开发服务：

```dotenv
VITE_DEMO_DATA=false
```

演示数据通过 `import.meta.env.DEV` 动态加载，生产构建不会包含对应数据模块。正式 API 覆盖这些页面后，应按文件内的 `TODO(release)` 删除整个 `frontend\src\mocks` 目录。

## 验证

以下命令均从项目根目录执行。

### 后端测试与静态检查

```powershell
Push-Location ".\backend"
& ".\.venv\Scripts\python.exe" -m pytest
& ".\.venv\Scripts\python.exe" -m ruff check app tests
Pop-Location
```

### 前端构建

```powershell
pnpm --dir ".\frontend" run build
```

如果 `pnpm` 报 `shim integrity check failed`，可使用 npm 临时调用项目声明的 pnpm 版本，按原锁文件安装依赖：

```powershell
Push-Location ".\frontend"
npm.cmd exec --cache "..\.cache\npm" --yes --package pnpm@11.19.0 -- pnpm install --frozen-lockfile --store-dir "..\.cache\pnpm-store"
npm.cmd run build
Pop-Location
```

Windows 沙箱可能限制 junction 的真实路径解析，使 `react-router-dom`、`motion/react` 和 React Query 的间接导出被误报为缺失。本次在沙箱外按现有锁文件安装，并通过完整构建；未为此修改包版本、锁文件或业务类型声明。遇到同类错误时先确认执行环境，避免添加占位声明掩盖问题。

提醒中心相关回归包括 `test_notifications.py`、`test_feed_creation.py`、`test_feed_update.py` 和 `test_season_change.py`。若系统临时目录权限异常，可为 pytest 指定工作区内独立的 `--basetemp` 目录及 `-o cache_dir=...`；pytest 会清理该临时目录，请使用测试专用路径。

### Windows 启动与热更新回归

使用独立测试服务，不连接项目数据库或下载器：

```powershell
& ".\scripts\test-dev-reload.ps1"
```
