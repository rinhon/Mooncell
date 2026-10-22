# NVENC 持续编码验证

日期：2026-10-20。NVENC 30 分钟实时持续编码通过；修复硬件关键帧参数后，实际服务 HLS 的四个分片独立完整解码通过。

本记录覆盖本机合成样本与本服务进程管理行为。浏览器普通播放、Anime4K 与 Linux 的完整结果分别记录，不把 null 输出的持续测试等同于浏览器播放验收。

## 环境与方法

| 项目 | 配置 |
| --- | --- |
| 系统 | Windows，本机运行 |
| 显卡 | NVIDIA GeForce RTX 4070 SUPER，显存 12,282 MiB |
| 驱动 | 610.88，由 `nvidia-smi` 实际读取 |
| FFmpeg | `7.1-essentials_build-www.gyan.dev` |
| 视频输入 | lavfi `testsrc2`，1280×720，24 fps，`-re` 实时读取 |
| 音频输入 | lavfi 440 Hz 正弦信号，48 kHz，AAC 双声道 128 kbps |
| 视频编码 | `h264_nvenc`，p3，VBR/CQ 23，目标 4.5 Mbps，峰值 6 Mbps，VBV 12 Mbps，GOP 72 |
| 输出 | null muxer，无大体积视频文件 |
| 进程控制 | 复用生产 `OwnedProcess` 与 Windows Job Object，结束/中断收割自建 FFmpeg |
| 并行负载 | 同机浏览器普通播放与 Anime4K 验收；GPU 未隔离，采样记录实际利用率 |
| 记录 | 每 15 秒采集源时间、区间速度、RSS、峰值 RSS、CPU 和 GPU/编码/解码利用率及显存 |

脚本为 [playback_hardware_stability.py](../scripts/playback_hardware_stability.py)。本次日志位于 `.cache\playback-hardware-stability\run-20261020-1`，包含 `status.json`、`samples.jsonl`、`stderr-tail.txt`。

```powershell
& '.\backend\.venv\Scripts\python.exe' scripts\playback_hardware_stability.py `
  --seconds 1800 --interval 15 `
  --output 'F:\code\mooncell\.cache\playback-hardware-stability\run-20261020-2'
```

此项测量硬件编码器持续产出和本服务进程管理行为。媒体格式、鉴权 HLS、字幕、浏览器时间映射和 WebGPU 渲染分别由其他播放验证记录覆盖。生产默认仍为 `libx264`；硬件编码器通过环境变量显式选择。

## 30 分钟实际结果

| 项目 | 实测 |
| --- | --- |
| 开始 | 2026-10-20 13:29:18.694，UTC 05:29:18.694 |
| 最终收割记录 | 13:59:32.801，UTC 05:59:32.801 |
| FFmpeg 末次源时间 | 1799.958333 秒，满足 1800 秒目标的一帧误差 |
| 脚本墙钟 | 1814.109 秒；每 15 秒轮询退出，包含结束后检测延迟 |
| FFmpeg 退出码 / stderr | 0 / 空 |
| 样本数 | 121 |
| 60 秒暖机后 RSS | 192.273–192.770 MiB |
| 暖机后最初 / 最后 5 个 RSS 均值 | 192.355 / 192.767 MiB，相差 0.412 MiB |
| 全程峰值 RSS | 202,133,504 字节，192.770 MiB |
| FFmpeg 进程 CPU 样本 | 0–9.4%（含启动） |
| 全机 GPU / encoder / decoder | 2–13% / 3–11% / 0–2% |
| 全机已用显存 | 2096–2790 MiB |
| 自建 FFmpeg | PID 56736，独占 Windows Job Object，最终已退出并收割 |

源时间与墙钟同步推进，未触发 45 秒无进度阈值，也未发生异常退出。末段视频帧 PTS 为 1799.958333 秒，24 fps 下距离目标结束一个帧间隔。RSS 在暖机后约 0.5 MiB 的窄范围波动，此次测试未观察到随时长持续增长。

GPU 数据来自 `nvidia-smi` 的全机采样，包含桌面、浏览器和其他开发进程；不能将全局显存的每次波动归因于 FFmpeg。本测试后段约 16 分钟与正式浏览器 30 分钟段重叠，其余时间亦有浏览器开发验证负载。

## 实际 NVENC HLS 验证与修复

使用独立 Python 子进程，临时设置自己的 `playback_encoder=h264_nvenc` 与专用缓存，生成 12 秒 1280×720/24 fps H.264/AAC 样本，调用生产 `probe_media`、`SessionManager` 和 HLS 清单。未修改实际后端设置、媒体库或开发服务会话。

首次运行发现 12 秒仅生成 10.416667 秒（250 帧）和 1.583333 秒（38 帧）两片。两片独立解码均成功，但没有达到每 3 秒独立分片的要求，因此保留为失败记录。原因由本机 `ffmpeg -h encoder=h264_nvenc` 核实：`-forced-idr` 默认为 false，强制关键帧不自动保证 IDR，HLS 等待到了默认 GOP 250 的 IDR 才切片。

正式参数仅在 NVENC 分支新增 `-forced-idr 1`，配合已有每 3 秒的 `-force_key_frames`；软件编码参数保持不变。修复后于 UTC 06:03:01–06:03:04 再次运行：

| 分片序号 | 首帧源时间 | 时长 | 独立解码帧数 | `-xerror` 退出码 |
| --- | --- | --- | --- | --- |
| 0 | 0 秒 | 3 秒 | 72 | 0 |
| 1 | 3 秒 | 3 秒 | 72 | 0 |
| 2 | 6 秒 | 3 秒 | 72 | 0 |
| 3 | 9 秒 | 3 秒 | 72 | 0 |

四片共 288 帧，全部用独立 FFmpeg 进程执行 `-xerror -err_detect explode` 解码，没有容错掩盖错误。清单包含 ENDLIST、TARGETDURATION 为 3；生产编码进程退出码 0，编码与各片解码 stderr 均为空。合成源和自有 HLS 缓存已清理，只保留结果 JSON 与诊断记录。

新增 `test_nvenc_forces_idr_for_independent_three_second_hls_segments` 验证 NVENC 参数、3 秒目标和软件分支不受影响，针对性运行 `1 passed, 16 deselected`；随后 root 复核完整会话/进程套件，结果为 **17 passed in 23.28s**。修改的业务文件、测试和脚本均通过 backend 严格 Ruff。最初沙箱内 pytest 因临时目录权限在 fixture 之前失败，之后通过正式沙箱外运行及专有 basetemp 完成该回归。

```powershell
& '.\backend\.venv\Scripts\python.exe' scripts\playback_hardware_stability.py `
  --hls-smoke `
  --output 'F:\code\mooncell\.cache\playback-hardware-stability\hls-repeat'
```

首次失败证据：`.cache\playback-hardware-stability\hls-20261020-1\nvenc-hls-result.json`。

修复成功证据：`.cache\playback-hardware-stability\hls-20261020-fixed-1\nvenc-hls-result.json`。

## NVENC 释放后的 GPU 只读采样

主编码结束后，于 UTC 06:01:59.118 开始每 30 秒只读采集 `nvidia-smi`，于 UTC 06:13:00.042 自动结束，进程退出码 0，共 23 条记录。UTC 06:02:29–06:03:15 的采样间隙用于修复与再次运行 12 秒 HLS；恢复后没有再启动测试编码器。

| 项目 | 实测 |
| --- | --- |
| 全机已用显存范围 | 2172–2228 MiB |
| 首次 / 最后显存 | 2188 / 2192 MiB |
| 最初 / 最后 5 个样本平均显存 | 2197 / 2189.2 MiB |
| GPU / encoder / decoder 范围 | 6–12% / 2–6% / 0–2% |

该尾段没有出现随时间持续上升的全机显存趋势。此结论仅覆盖本次时间窗口；`nvidia-smi` 并未隔离浏览器、桌面或其他进程的分配，不作为单个进程无泄漏的证明。

记录：`.cache\playback-hardware-stability\run-20261020-1\gpu-browser-tail.jsonl`。每条记录的 `test_encoder_running=false` 只指本任务的测试编码器已关闭；浏览器和桌面仍可使用 GPU。

可审阅的汇总与尾段原始样本存于 [video-playback-hardware-result.json](video-playback-hardware-result.json)。完整主编码 121 条原始样本保留在上述 `.cache` 目录。所有本任务创建的 FFmpeg 与采样进程均已结束；没有终止其他进程。
