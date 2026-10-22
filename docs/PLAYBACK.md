# 在线播放与 Anime4K

从番剧详情的本地分集点击“播放”，进入独立播放页。播放器提供完整影片时间轴、任意跳转、选集、音轨、清晰度、倍速、全屏及续播。播放页会卸载全局动态背景。

## 运行要求

- 后端安装 FFmpeg、FFprobe 与项目 Python 依赖；Docker 镜像内置 FFmpeg。
- 后端只能使用一个 worker，同一缓存目录只能由一个服务实例使用。会话不跨进程共享，重启后从观看记录建立新会话。
- 浏览器使用 hls.js 和 MSE；Chrome、Edge 是主要验收对象。Firefox 普通播放需另行验收。原生 Safari HLS 暂不开放，以免未经验证的直播时间轴行为影响点播。
- 输出为 H.264 8-bit SDR、AAC 双声道，支持无音轨文件。720p、1080p 均只缩小，不在服务器放大片源。
- HDR 会明确拒绝播放，避免未经色调映射产生错误颜色。支持 UTF-8 SRT、WebVTT 与内嵌文本字幕；ASS/SSA、PGS 等轨道显示不支持原因。

## 配置

所有配置通过后端 `MOONCELL_` 环境变量设置。默认缓存位于后端工作目录 `data\playback`，Docker 对应 `/app/data/playback`，已包含在数据卷内。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `MOONCELL_PLAYBACK_FFMPEG` | `ffmpeg` | FFmpeg 可执行文件或完整路径 |
| `MOONCELL_PLAYBACK_FFPROBE` | `ffprobe` | FFprobe 可执行文件或完整路径 |
| `MOONCELL_PLAYBACK_CACHE_PATH` | `./data/playback` | 独占的转码缓存目录 |
| `MOONCELL_PLAYBACK_ENCODER` | `libx264` | 编码器，默认软件编码 |
| `MOONCELL_PLAYBACK_THREADS` | `2` | 软件解码/编码线程数，限制为 1–16 |
| `MOONCELL_PLAYBACK_MAX_SESSIONS` | `1` | 全局并发转码上限，挂起进程也计入 |
| `MOONCELL_PLAYBACK_SESSION_QUOTA_MB` | `512` | 单会话磁盘配额 MiB |
| `MOONCELL_PLAYBACK_GLOBAL_QUOTA_MB` | `4096` | 全局磁盘配额 MiB |
| `MOONCELL_PLAYBACK_MIN_FREE_MB` | `512` | 最低磁盘余量 MiB，另预留一个分片的写入空间 |
| `MOONCELL_PLAYBACK_PROBE_TIMEOUT_SECONDS` | `20` | 探测、字幕提取超时 |

`GET /api/v1/settings/playback/capabilities` 需要登录，报告工具可用性与配置编码器的实际短片自检结果。改变编码器后重启后端；不是仅检查 `-encoders` 列表。

Windows 可按实际自检结果选择 `h264_nvenc`、`h264_qsv`、`h264_amf` 或 `h264_mf`。配置的硬件编码启动失败时仅尝试一次 `libx264` 软件回退。本机 P0 短片 NVENC、Media Foundation 编码成功，QSV、AMF 失败；这不等于目标硬件的持续转码验收。

Docker 的默认 Alpine 镜像以软件编码为交付基线。GPU 加速需要与驱动、FFmpeg 构建兼容的镜像和设备映射；不要仅添加环境变量便假定 GPU 已可用。NVIDIA 环境通常还需 NVIDIA Container Toolkit 和 GPU reservation；QSV 通常需映射 `/dev/dri`、设备组权限及对应运行库。先在容器内实际编码自检，再运行长时间负载测试。不要增加 Uvicorn worker 数来提升转码并发。

## HTTPS 与画面增强

Anime4K 默认关闭，设备偏好保存在当前浏览器。轻量、标准模式使用 `anime4k-webgpu@1.0.0` 的 CNN 模型；普通播放与增强共用同一 video，切换不重建服务端会话。字幕和控制层保留在播放器容器内。

WebGPU 需要安全上下文。`http://localhost` 可用于本机开发；局域网 IP 的 HTTP 页面会显示增强不可用原因并继续普通播放。局域网部署应在前端外层配置可信 HTTPS，例如 Caddy、Nginx 或现有网关：

1. 为域名配置 DNS 与设备信任的证书。
2. HTTPS 反向代理到前端容器的 80 端口，沿用前端 `/api` 同源代理。
3. 设置 `MOONCELL_SESSION_COOKIE_SECURE=true` 与实际 HTTPS 的 `MOONCELL_ALLOWED_ORIGINS`。
4. 验证登录 Cookie、HLS 清单/分片、字幕均来自同一 HTTPS 源；不要绕过浏览器证书警告或关闭安全限制。

设备不支持 WebGPU、GPU 丢失或性能不足时会回到普通播放。增强输出与中间纹理均有尺寸上限，持续超出帧预算会从标准降到轻量，再关闭，并给出一次提示。首版未开放画中画。

## 会话与文件整理

会话与清单、分片、字幕均使用同源 Cookie 鉴权，资源响应 `Cache-Control: no-store`。退出播放器会保存位置并停止转码；浏览器异常关闭后由心跳超时回收，不能依赖页面关闭事件。

转码在领先约 90 秒时挂起、降至约 30 秒恢复；暂停播放会挂起，长暂停约 60 秒释放进程，继续播放时按保存位置建立新代次。约 120 秒失联回收会话。窗口外 seek 会重建代次，不受已生成分片范围限制。时间映射读取分片实际视频 PTS，并与 hls.js 解复用后的媒体时间对齐。

自动季度迁移和修订版替换会先阻止新播放，等待已有播放释放文件后继续。文件版本改变会使媒体 ID 和探测缓存失效，旧会话需要刷新分集列表后重新进入。

## 验证记录

- [交付与验证范围](video-playback-validation.md)
- [开发计划](video-playback-plan.md)
- [FFmpeg 与进程控制 P0](video-playback-p0-process.md)
- [Anime4K 适配与生命周期 P0](video-playback-p0-anime4k.md)
- [Linux/Docker API 与 HLS](video-playback-linux.md)
- [硬件持续转码](video-playback-hardware.md)

跨浏览器、Linux/Docker、GPU 持续负载和至少 30 分钟稳定性结果需按实际环境记录；未执行的项目不视为已通过。
