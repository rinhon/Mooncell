# P0：真实 FFmpeg 与进程控制验证

日期：2026-10-20。环境：Windows、Python 3.12.14、FFmpeg/FFprobe 7.1、psutil 7.2.2。

此记录覆盖服务器分片、时间戳、硬件编码短片自检与 Windows 进程生命周期。Linux 容器实测见 [Linux 验证记录](video-playback-linux.md)，30 分钟生产构建播放的容器资源与卸载回收见 [稳定性资源记录](video-playback-container-stability.md)。浏览器时间轴、Anime4K 及最终续播行为由对应验收记录说明。

## 复现

项目根目录运行：

```powershell
& backend\.venv\Scripts\python.exe scripts\playback_p0.py
```

脚本仅生成合成短片，不下载媒体，输出位于 `backend\data\playback-p0\run-日期-时间\`。生成原片、转码参数、清单、各分片 FFprobe 信息、硬件实际编码结果和进程验证都写入该目录的 `report.json`；产物位于已忽略的 `backend\data`，不进入 Git。

会话回归：

```powershell
Set-Location backend
& .\.venv\Scripts\python.exe -m pytest tests\test_playback_sessions.py -q
```

Windows Codex 沙箱实测出现过临时目录不可写，以及对子 FFmpeg 创建的样本执行 `Path.resolve(strict=True)` 返回 WinError 5；这与 FFmpeg/psutil 本身是否可运行不同。采用正式沙箱外测试后，真实会话回归通过。没有调整系统 ACL 或关闭全局沙箱。

## 时间戳结论与正式参数

使用普通有限滚动 HLS；不设 EVENT/VOD 类型。FFmpeg 使用 `temp_file+independent_segments` 原子发布，约 3 秒强制关键帧；服务端登记完成分片，并按源时间窗口和读取引用回收。23.976/29.97 fps 样本分片实际为约 3.003 秒，API 与清单使用实际时长。

正式参数的关键部分：

```text
-copyts -start_at_zero
-ss COARSE_POSITION
-protocol_whitelist file,pipe
-format_whitelist mov,matroska,webm,avi,mpegts,mpeg,flv,asf,ogg
-i LOCAL_FILE
-vf trim=start=TARGET_POSITION,scale=WIDTH:HEIGHT
-af atrim=start=TARGET_POSITION
-c:v libx264 -preset veryfast -crf 23 -bf 0
-force_key_frames expr:if(isnan(prev_forced_t),1,gte(t,prev_forced_t+3))
-c:a aac -b:a 128k -ac 2 -ar 48000
-f hls -hls_time 3 -hls_list_size 60
-hls_flags temp_file+independent_segments
-hls_segment_options mpegts_copyts=1:output_ts_offset=1.0
```

轨道从 FFprobe 选择的真实视频/音频流映射；无音轨时 `-an`。输出尺寸取源尺寸与请求档位的较小值并保持比例。生产代码还限制线程、码率、协议与全局转码并发。

生产输入另设 `-readrate 8`，约束极小分辨率片源的超高速产出，为配额检测保留可控余量。每次检测先检查进度水位与磁盘占用，再提交分片探测；FFprobe 在独立任务执行，最多 2 个并发、每会话最多 4 个待处理分片，不占用控制请求的全局锁。旧代次探测会取消并收割。

时间映射必须包含以下两步：

1. TS muxer 固定加 1 秒，故 `分片源时间 = FFprobe 首视频 PTS - 1 秒`。API 的 `segments` 包含序号、该源时间与实际时长；`media_anchor` 保留实际 TS PTS，供诊断。
2. 浏览器 HLS 解复用可能重置时间原点；前端通过 `FRAG_BUFFERED` 的 `frag.sn` 与 `elementaryStreams.video.startPTS`（或合并的 audiovideo 起点），匹配 `segments`，建立源时间和 `video.currentTime` 的映射。后端 TS PTS 不能直接当作浏览器 currentTime。

这 1 秒偏移用于保留 AAC 约 21.333 ms 的编码预热：若全部时间戳直接重置，起点视频会被整体推迟 21.333 ms；若直接禁用负数平移，首 AAC PTS 会在 MPEG-TS 中绕回约 95443 秒。实际测试中固定偏移后首视频为 `1.000000`、首 AAC 为 `0.978667`，不会跨过回绕边界。

24 fps MP4 从源 7.3 秒定位，实际首帧为源 `7.333333`，输出视频 PTS 为 `8.333333`；音频为 `8.278667`。后续视频分片连续每 3 秒增长，初始音视频时间戳差约 54.7 ms。此结果验证时间戳关系，不替代真实片源的声画人工验收。

额外创建容器起点约 5 秒的 TS，发现直接输入 `-ss 7.3` 可能落到源 10 秒关键帧。正式实现对 TS/M2TS/MTS 从 `max(0, target - 30)` 粗定位，再使用保留 PTS 的 `trim/atrim`；实际 seek 7.3 后首视频 PTS 为 `8.333333`。如果其他容器的索引仍使首帧明显越过目标，只自动重试一次从头解码。源容器起点通过 `-start_at_zero` 归一化。

## 合成片测量

下表来自同次诊断；测量期间机器存在其他开发和测试进程。首段落盘时间不是完整浏览器首帧时间，也不是任意片源的性能承诺。

| 输入 | 操作 | 首个完整分片 | 备注 |
| --- | --- | --- | --- |
| MP4、H.264/AAC、720p、24 fps、24 秒 | 从头 | 约 0.42 秒 | 8 个分片；滚动清单保留 3 个条目 |
| 同上 | seek 7.3 秒 | 约 0.64 秒 | 实际首源帧 7.333333 秒 |
| MKV、HEVC、1080p、29.97 fps、6 秒 | 转 H.264 HLS | 约 2.44 秒 | 分片约 3.003 秒 |
| MKV、H.264、720p、23.976 fps、6 秒、无音轨 | 转 H.264 HLS | 约 0.86 秒 | 纯视频可正常分片 |

## 暂停、恢复与异常退出

实测自建 FFmpeg 进程：运行后 psutil 挂起 1.6 秒，输出时间从 `2041667 us` 到 `2041667 us`，保持不变；恢复后推进至 `5500000 us`。再次挂起后先恢复，再通过 stdin 写入 `q`，退出码为 0；独立验证 `terminate()` 能等待该自建进程退出。

Windows 正式模块采用独占、不可继承的 Job Object，并设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`。FFmpeg 先以 `CREATE_SUSPENDED` 创建，加入 Job 后再恢复，避免父进程退出与登记之间产生孤儿。诊断强杀模拟后端，不走 Python finally，FFmpeg 在约 0–16 ms 内被内核回收。仅操作脚本创建的 PID，不按进程名终止其他 FFmpeg。

Linux 实现使用独立 Python exec 包装器设置 `PR_SET_PDEATHSIG=SIGKILL`，同时复查父 PID 后 exec FFmpeg。独立 Docker 验证已确认暂停/恢复、正常关闭和 `os._exit` 父进程异常退出回收通过；实际镜像与复现命令见 [Linux 验证记录](video-playback-linux.md)。这不涵盖 Linux 浏览器 GPU、HTTPS 或硬件编码。

会话实现还覆盖：暂停中 seek 先生成首段更新静态画面，再挂起；暂停 60 秒释放转码和源文件租约；恢复时重新检查媒体版本并建立新代次；过期代次控制和分片请求拒绝；旧代次在途分片的引用持续保护；关闭后短时间内允许最后一次同代次进度落盘。

同一缓存根使用 Windows `msvcrt.locking` / POSIX `flock` 的非阻塞独占锁。只有持锁 worker 可清理启动残留并调度会话，重复实例明确报错。该锁的跨进程竞争/释放已在 Windows 验证。

缓存清单只发布连续序号区间；因在途读取而保留的旧分片不会造成清单序号空洞。缓存内 seek 经服务端验证后保留 generation，同时重设播放位置的墙钟锚点；普通心跳只累计实际经过的墙钟时间，不能通过密集心跳反复获得 15 秒容差。分片引用由完整 ASGI 响应生命周期释放，包含响应开始前断开的情况。

FFmpeg 退出不直接等于清单完成：只有所有仍存在的已发布分片完成异步探测和登记，清单才发布 ENDLIST，并释放源文件租约；避免播放器先读到提前结束的清单，随后遗漏尾段。

刷新恢复增加可选 UUID `client_id`，由前端同一标签页保留。请求幂等校验优先；新创建请求只替换同用户、同 client_id 的旧会话，先回收其进程再申请转码名额。不同用户、不同 client_id 或未传 client_id 的请求不会抢占其他播放。即使页面退出时的 DELETE 丢失，同标签页刷新也能立即重新创建并续播。加入 NVENC 强制 IDR 参数回归后，最终 17 项会话/进程测试全部通过。

## 硬件短片自检

每种编码器均实际编码 1 秒 720p H.264 文件，成功后经 FFprobe 校验；没有依据 `-encoders` 列表推断可用性。

| 编码器 | 本机结果 |
| --- | --- |
| libx264 | 成功，软件基线 |
| h264_nvenc | 成功，可作为后续部署候选 |
| h264_mf | 成功，不能仅凭成功断定实际使用硬件 |
| h264_qsv | 失败，MFX session 初始化错误 |
| h264_amf | 失败，amfrt64.dll 不可用 |

本机 NVENC 后续完成 30 分钟连续编码资源测试，并验证修复后的 12 秒 HLS 输出为 4 个独立可解码的 3 秒分片；NVENC 需要 `-forced-idr 1` 才能使强制关键帧满足独立分片要求。详细证据见 [硬件持续编码与 HLS 验证](video-playback-hardware.md)。正式默认使用软件编码；配置硬件编码失败时仅允许一次软件回退。浏览器与完整 HLS 的 30 分钟稳定性测试使用 libx264，范围单独记录。

## 依据

- [FFmpeg HLS muxer、原子分片和滚动清单](https://ffmpeg.org/ffmpeg-formats.html#hls)
- [Microsoft Job Objects：句柄关闭与进程回收](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [Microsoft SetInformationJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-setinformationjobobject)
- [psutil 官方进程控制文档](https://psutil.readthedocs.io/en/latest/#psutil.Process.suspend)
