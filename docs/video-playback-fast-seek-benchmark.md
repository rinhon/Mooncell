# 播放跳转性能基准

日期：2026-10-23。脚本为 `scripts\benchmark_playback_seek.py`。

该基准分别测量创建会话、服务端分片缓存内跳转、未缓存目标的冷跳转。**服务端 ready、分片首字节或下载完成均不是浏览器目标帧呈现时间。** 默认使用生产 SessionManager 和 FFmpeg，在 `.cache\playback-seek-benchmark\run-时间-随机标识\` 内合成测试片、建立独立缓存并输出 `report.json`；不注册媒体、不连接数据库、不修改真实媒体库、不启动开发服务。

## 默认合成片基准

从项目根目录使用现有后端虚拟环境，依赖 FFmpeg、FFprobe 及已经安装的后端依赖，不安装额外包：

```powershell
& backend\.venv\Scripts\python.exe scripts\benchmark_playback_seek.py --rounds 30
```

默认片源为 120 秒、640×360、24 fps 的 H.264/AAC MP4，输入 GOP 120 帧；输出使用实际生产转码命令。每轮重新创建专有会话，从已登记首片选择缓存目标，再选择清单缓存范围以外的冷跳目标。脚本关闭自己创建的会话，停止自己创建的进程，保留独立目录供诊断；不会按进程名回收其他 FFmpeg。

短时 smoke（只能证明脚本可运行，不作为性能结论）：

```powershell
& backend\.venv\Scripts\python.exe scripts\benchmark_playback_seek.py --rounds 2 --duration 24 --size 320x180
```

2026-10-23 已完成该 smoke：创建、缓存跳转、冷跳转各 2 次成功，退出码 0；高精度计时报告位于 `.cache\playback-seek-benchmark\run-20261023-084024-6063d402\report.json`。首次沙箱内运行可完成合成和 FFprobe，但 `Path.resolve(strict=True)` 对新合成片返回 WinError 5，随后经正式授权在沙箱外通过；没有修改 ACL、关闭沙箱或绕过生产路径校验。这 2 次样本不构成 P95 性能基线。

指定编码器、帧率或已有本地文件：

```powershell
& backend\.venv\Scripts\python.exe scripts\benchmark_playback_seek.py --rounds 30 --encoder h264_nvenc --frame-rate 24000/1001
& backend\.venv\Scripts\python.exe scripts\benchmark_playback_seek.py --rounds 30 --media 'F:\测试媒体\样片.mkv'
```

本地文件只读；源文件版本、轨道、尺寸、时长、帧率、编码器配置、FFmpeg 版本和机器信息写入报告。元数据探测在操作计时前完成，独立记录 `metadata_probe_ms`。合成片很小，结果不能代表 4K、长 GOP 或 NAS 片源。`cold_seek` 仅表示不在该会话的分片缓存中；脚本不清除操作系统文件缓存，也不声称复现物理冷盘。

manager 调用保持不传客户端能力的旧接口，用于单独测量现有转码路径，避免自动直放改变场景。报告的 `source_code` 记录实验开始和结束时的播放模块及脚本 SHA-256；`files_changed_during_run` 非空时表示存在并行开发，只能解释为该进程启动时导入代码的实验，不能据此声称最终工作树版本性能稳定。

## HTTP 测试

HTTP 模式通过现有已认证 API 测量，适合显式选定的测试媒体或专用测试会话。Cookie 以完整 Cookie 请求头值保存在环境变量 `MOONCELL_BENCHMARK_COOKIE`，通过已有登录流程获取；脚本不记录它，不接受命令行明文 Cookie，也不将 Cookie 跟随重定向发送到其他 origin。不要把 Cookie 写进报告、提交文件或公开日志。

对测试媒体逐轮创建并关闭会话，可获得三个场景：

```powershell
# 先在当前进程的环境变量 MOONCELL_BENCHMARK_COOKIE 中设置有效 Cookie。
& backend\.venv\Scripts\python.exe scripts\benchmark_playback_seek.py --mode http --base-url 'http://127.0.0.1:8000' --media-id '测试媒体ID' --rounds 30 --server-label '开发机' --network-label '同机环回，无人工延迟' --encoder libx264
```

使用已有专用会话：

```powershell
& backend\.venv\Scripts\python.exe scripts\benchmark_playback_seek.py --mode http --base-url 'http://127.0.0.1:8000' --session-id '专用测试会话ID' --rounds 30 --network-label '千兆局域网'
```

已有会话不会被脚本关闭，但跳转会改变其播放位置和代次；不要选择正在观看的会话。创建场景明确标记为 skipped。片长太短或全部内容已经缓存时，冷跳也标记 skipped，不将缓存命中伪装为冷跳；可通过 `--cold-target 90` 指定未缓存位置，或改用逐轮创建的较长测试媒体。

HTTP 模式的客户端机器信息不代表服务器配置；`--server-label`、`--encoder` 和 `--network-label` 是用户声明的实验元数据，需与实际部署配置核对。网络参数只做记录，脚本不自动修改系统网络。HTTP 各操作包含真实请求耗时；不会写入观看记录，但 playback-info 可能触发服务器已有的探测缓存持久化逻辑。

## 报告字段

`rows` 保存逐轮成功、失败和 skipped 原因；`summary` 按场景汇总成功数、失败率及每项毫秒指标的 P50/P95/最大值。失败率为 failed / (successful + failed)，skipped 单独统计。分位数在成功样本上按 `(N-1)×p` 线性插值；每场景至少 30 次，少量 smoke 不适合比较 P95。

| 指标 | 定义 |
| --- | --- |
| `control_response_ms` | 本脚本发起 create/seek 至控制调用返回 |
| `ready_observed_ms` | 发起操作至观察到 ready/paused；包含控制调用与状态等待 |
| `playlist_ms` | ready 后取清单耗时 |
| `segment_open_ms` | manager 模式获得目标分片读取引用的耗时 |
| `segment_first_byte_ms` | 分片请求/读取开始至首字节，不含先前 ready 等待 |
| `segment_download_ms` | 分片请求/读取开始至完整读取结束 |
| `operation_to_first_byte_ms` | 操作开始至目标分片首字节，包含前述准备与取清单 |
| `operation_to_download_ms` | 操作开始至目标分片读取完成 |
| `server_stop_ms` / `server_spawn_ms` | 后端新增 timings 中的旧进程退出/新进程启动耗时 |
| `server_first_segment_ms` / `server_ready_ms` | 后端从当前 generation 准备开始计时的首片/就绪耗时 |

后端 `revision` 可用时，脚本使用 `after_revision` 与有界 `wait_ms` 等待状态变化；旧版后端回退至默认 50ms 轮询，可通过 `--poll-ms` 调整。旧后端没有的 timings 不会被伪造；缓存跳转不重复统计上一代次准备耗时。所有脚本时长来自本机单调高精度 `time.perf_counter()`，报告保存其分辨率；后端 timings 仅按其自身时钟解释，绝不直接相减两端时间戳。

退出码 0 表示操作没有失败，仍需检查各场景 skipped 数；退出码 1 表示操作、初始化或回收失败。认证失效、并发槽不足和目标缺片均保留为失败或明确的前置条件缺失，不能从样本中静默删除。

## 浏览器目标帧证据

真实端到端指标由播放器另行记录。浏览器开发工具中读取或导出：

```javascript
window.__mooncellPlaybackMetrics.read()
JSON.stringify(window.__mooncellPlaybackMetrics.read(), null, 2)
```

重点比较相同片源、编码器、浏览器和网络条件下的 `firstFrameMs`，同时检查 `frameSourceTime` 是否命中最新目标以及 `frameEvidence` 是否为 `video-frame`。`seeked-fallback` 属于兼容性退化证据，不能与 `requestVideoFrameCallback` 目标帧证据混合成同一“已呈现”结论。连续拖动中被 superseded 的旧目标单列，不能当作新目标的首帧。

浏览器 `startedAt` 属于浏览器自身 `performance.now()` 时钟，不能与服务端或本脚本时间戳相减。脚本请求和交互式浏览器拖动是两组独立操作；对齐片源与条件后比较各自的场景分布，不把两组操作按近似时间或不同的 seek ID 强行合并。Anime4K 开启时，还需区分 video 帧证据和 Canvas 实际提交目标帧的时刻。

## 2026-10-23：30 轮合成片记录

本次在北京时间 16:43–16:44 经正式授权运行默认命令，报告位于 `.cache\playback-seek-benchmark\run-20261023-084309-8e86f117\report.json`。创建、缓存跳转、冷跳转各 30 次成功，失败率均为 0，跳过数均为 0。实验为单进程 SessionManager 调用，不经过 HTTP 或浏览器；没有更改真实媒体库。

条件：Windows 11、Python 3.12.14、FFmpeg 7.1、20 个逻辑处理器、约 31.7 GiB 物理内存；120 秒 640×360/24 fps H.264/AAC 合成 MP4，软件编码 libx264、2 线程。每轮从 0 秒创建，缓存跳转目标约 0.5 秒，冷跳转目标为 96 秒。计时使用 QueryPerformanceCounter，报告分辨率为 100 ns。同期未独占整机资源。

下表单位为毫秒，每格为 P50 / P95：

| 场景 | 控制调用返回 | 观察到 ready | 操作至分片首字节 |
| --- | --- | --- | --- |
| 创建 | 15.046 / 54.932 | 710.298 / 1257.073 | 710.528 / 1257.447 |
| 服务端缓存跳转 | 0.159 / 0.176 | 0.186 / 0.205 | 0.433 / 0.669 |
| 冷跳转 | 0.180 / 0.284 | 898.162 / 1248.550 | 898.376 / 1248.947 |

冷跳转的服务端阶段分别为：旧进程停止 170.636 / 214.912 ms、新进程启动 9.787 / 13.080 ms、首片封口观察 803.446 / 1115.234 ms、服务端 ready 883.288 / 1240.969 ms。后两项均从准备开始累计，不能将四项相加。

报告检测到 `backend\app\playback\sessions.py` 在实验期间发生磁盘变更；该 Python 进程不重载已导入的模块，因此结果仅描述该次加载的旧接口转码实现。它不是最终 P2/P3 集成代码的稳定性验收，也没有优化前同条件对照，不能据此宣称提升百分比或浏览器已经“秒跳”。

本记录不满足 P4 虚拟 HLS 的默认启用门槛。仍欠缺真实浏览器目标帧分布、完整索引与可重复分片边界实测、23.976/29.97 fps 与 VFR 长时间轴、跨生产 job 的 PTS/DTS 和 AAC 边界验证、旧预取与连续拖动的重启次数、并发缺片请求取消/超时、淘汰后重建，以及与 P1–P3 在相同条件下的 P95 对照。完成前继续使用常规有限窗口 HLS；本轮没有实现或启用完整虚拟清单。

## P5：同源软件与硬件编码对照准备

2026-10-23 已核实候选同源片为 `F:\code\mooncell\.cache\fastseek-e2e\run-c97b4203\library\Playback validation\Validation S01E01.mp4`：H.264、1280×720、24 fps、120 秒。实际执行了该源的 1 秒 NVENC 编码并用 FFprobe 验证输出，返回码 0，输出为 1280×720/24 fps H.264、时长 1 秒；GPU 为 NVIDIA GeForce RTX 4070 SUPER，驱动 610.88。自检报告为 `.cache\playback-p5-readiness\run-72bdbd5a\report.json`。

该自检只确认硬件编码器可用，不确认硬解码或设备侧缩放，也不能代表跳转耗时。长测安排在浏览器性能测试结束后的独立窗口，以下两条命令顺序执行，避免争用编码资源：

```powershell
& backend\.venv\Scripts\python.exe scripts\benchmark_playback_seek.py --mode manager --rounds 30 --media 'F:\code\mooncell\.cache\fastseek-e2e\run-c97b4203\library\Playback validation\Validation S01E01.mp4' --encoder libx264 --network-label '同源720p软件编码对照，无HTTP，无浏览器并发测试'
& backend\.venv\Scripts\python.exe scripts\benchmark_playback_seek.py --mode manager --rounds 30 --media 'F:\code\mooncell\.cache\fastseek-e2e\run-c97b4203\library\Playback validation\Validation S01E01.mp4' --encoder h264_nvenc --network-label '同源720p硬件编码对照，无HTTP，无浏览器并发测试'
```

两组保持相同源文件、帧率、时长、2 线程设置和生产 `-readrate 8`，不传 capabilities，均走完整视频转码路径。对照前核对报告的媒体 version 一致、源码指纹无中途变动、每组各场景 30 个有效样本；先比较首片、ready 和旧进程退出耗时，再判断编码是否为主要限制。没有同源数据前，不调整 readrate，不增加硬解码/设备缩放功能。

## P5：最终同版本 720p 对照与决策

北京时间 2026-10-23 20:00–20:02，在 HTTP/浏览器编码测试结束后顺序执行上述两组。libx264 与 NVENC 各自的创建、缓存跳转、冷跳转均为 30/30 成功、0 失败、0 跳过；所有快照均为 `transcode`。每组创建及缓存跳转的 generation 均为 1，冷跳转均为 2，未出现额外回退代次。

原始报告和对照证明：

- libx264：`.cache\playback-seek-benchmark\run-20261023-120015-926f3a6b\report.json`。
- NVENC：`.cache\playback-seek-benchmark\run-20261023-120127-42ef0ed3\report.json`。
- 同源与源码核对：`.cache\playback-p5-readiness\final-comparison-20261023.json`。

两组 `source_code.started` 与 `source_code.finished` 均完全一致，`files_changed_during_run` 均为空；两组之间的 15 个源码指纹也完全相同。该指纹表以键排序、紧凑 JSON 编码后的 SHA-256 为 `64658ccebdb3f5565f595493e21f1f79bd272cc9806399651b1b0727c29d8bf1`。媒体 version 同为 `309d524266500105a770f7308c83e3f85ba507a0c14912d877423a0ed74c1227`。条件仍为同一 1280×720/24 fps/120 秒 H.264/AAC 源，2 线程、`-readrate 8`；GPU 型号及实际可用性见前述自检。

下表单位为毫秒，每格为 P50 / P95；均为无 HTTP 的服务端操作测量：

| 场景 | libx264：观察到 ready | NVENC：观察到 ready | libx264：操作至首字节 | NVENC：操作至首字节 |
| --- | --- | --- | --- | --- |
| 创建 | 729.762 / 827.555 | 732.271 / 2006.809 | 730.222 / 827.840 | 732.569 / 2007.170 |
| 服务端缓存跳转 | 0.232 / 0.335 | 0.212 / 0.312 | 0.532 / 0.723 | 0.491 / 0.677 |
| 冷跳转 | 932.781 / 1000.799 | 924.368 / 987.127 | 933.095 / 1001.058 | 924.710 / 987.390 |

冷跳转各服务端阶段的 P50 / P95：

| 阶段 | libx264 | NVENC |
| --- | --- | --- |
| 旧进程停止 | 175.406 / 222.023 | 204.273 / 246.006 |
| 新进程启动 | 13.457 / 14.471 | 11.427 / 13.759 |
| 准备开始至首片封口观察 | 811.669 / 880.227 | 812.627 / 861.149 |
| 准备开始至服务端 ready | 916.689 / 986.323 | 912.918 / 969.910 |

NVENC 保留了长尾：第 2、25 轮创建分别为 2985.451、3830.497 ms；第 25 轮冷跳转为 4001.024 ms，其中旧进程停止为 3235.671 ms。软件组创建和冷跳转的最大值分别为 860.363、1052.046 ms。没有删除慢样本，也没有依据现有阶段数据推断长尾的驱动、调度或磁盘原因。

**P5 决策：保持默认 libx264、`readrate 8` 和现有解码/缩放管线。** 在这个 720p 样本中，NVENC 的冷跳转中位数及 P95 与软件编码接近，创建长尾还更大；该单组顺序对照没有证明切换编码器能稳定改善目标指标，也没有把读取限速、解码、缩放、编码和监控发现时间分别隔离。它不足以支持降低读取保护或新增硬解码/设备侧缩放。

已有 NVENC 配置能力仍可按部署设备选择。后续只有在更高分辨率、代表性编码与长 GOP 片源上完成独立资源采样和真实浏览器验帧，且瓶颈明确落在解码/缩放/编码时，再开启相应实验；改变 readrate 需同时对照产出峰值、缓存配额和磁盘余量。本次结果不代表浏览器首帧，不用于推断所有设备上硬件编码的优劣，也不改变 P4 虚拟 HLS 的未启用结论。
