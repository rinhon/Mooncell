# 工作区约定

- 使用 Windows PowerShell 命令和反斜杠路径；用简体中文回复用户。
- 图片操作优先使用 ImageMagick（`magick`），视频操作使用 FFmpeg。
- 本项目禁止使用 DevSpace 插件及其全部工具；文件操作和命令执行使用本地工具。

## 启动开发服务

- 固定从项目根目录使用以下命令启动，避免临时变更命令形式导致已保存的授权无法匹配：

  ```powershell
  powershell.exe -NoProfile -File F:\code\mooncell\scripts\dev.ps1
  ```

- Codex Windows 沙箱曾导致 pnpm 路径解析 EPERM，以及 Uvicorn 重载子进程的命名管道错误（WinError 2）。遇到这些权限问题时，通过正式的 `require_escalated` 流程运行上述固定入口；仅在已有匹配授权或用户批准后执行。建议的持久授权前缀应包含 `powershell.exe`、`-NoProfile`、`-File` 和完整脚本路径，不能放宽为任意 PowerShell 命令。
- 构建、测试、Vite preview 的授权不覆盖开发启动。不要将一次沙箱外运行成功描述为沙箱本身已修复，也不要关闭全局沙箱或修改系统 ACL 来规避授权。
- 依赖通过 pnpm 安装；启动脚本直接调用已安装的 Vite，启动时不安装依赖。等待脚本确认前后端 HTTP 就绪后，再报告启动成功和实际地址。
