# 生产构建播放：30 分钟容器资源验证

日期：2026-10-20。北京时间 13:42:46–14:12:46（UTC 05:42:46–06:12:46），完成 1800 秒、每 15 秒一次的 121 个样本，全部成功，采样器退出码 0。

测试环境为专有 Docker 后端、nginx 和前端生产构建，使用独立数据库、媒体库与缓存。合成源为 2000.020996 秒、1280×720 H.264/AAC，由既有短片通过 FFmpeg stream copy 循环封装，未重新编码整部长片。后端本轮使用 **libx264**；播放页标准 Anime4K 的实际浏览器表现见 [验收截图](video-playback-stability.jpg) 与总验收记录。

长测构建的 `index.html` 修改时间为 UTC 2026-10-20T05:38:50.933923+00:00，主 bundle 为 `index-CrvD4bNo.js`，index SHA-256 为 `1a3ef81bcaf7f3cd5b68601cd3a5ccc1597b24d12dfa6efb573b93426777ae35`。该清单在长测后、最终续播查询补修重新构建前补采；mtime 早于长测起点。总验收另记录同片重进续播查询缓存的前端查询生命周期补修及行为复验；该补修不改 HLS 引擎或转码资源循环，未重新执行本次 30 分钟长测。

补修生产构建完成于 UTC 06:17:15.352，index SHA-256 为 `58bbeb6d857be9793a607d973a9bd1435d215178d2a82aa51e2d84f763f8a2ec`。浏览器复验确认：长片定位 30:00 后返回作品页、再次点击同集，播放器初始滑块仍为 1800 秒并正常播放。该结果是最终补修的短行为验证。

## 实测结果

先预热 120 秒，再比较 120–720 秒与 1200–1800 秒两个 10 分钟窗口，各有 41 个样本。

| 指标 | 预热后首 10 分钟 | 最后 10 分钟 |
| --- | ---: | ---: |
| 后端平均 RSS | 105.16 MiB | 105.30 MiB |
| 后端 RSS 范围 | 104.13–105.76 MiB | 104.80–105.77 MiB |
| FFmpeg 平均 RSS | 125.96 MiB | 125.88 MiB |
| FFmpeg RSS 范围 | 125.38–126.68 MiB | 124.85–126.82 MiB |

后端平均 RSS 相差 0.15 MiB，最后 10 分钟线性斜率为 -0.0034 MiB/分钟。两种进程的平均 RSS 基本持平。

121 个样本中 FFmpeg 数量均为 1，容器内 PID 为 385，后端 PID 为 7；期间没有重启本轮转码。缓存文件逻辑字节峰值 81.63 MiB，结束时 37.57 MiB；Linux 报告的分配空间峰值 81.79 MiB。分片数量峰值 89，结束时 40。关闭的短片会话缓存按宽限期从 5 个目录收敛至当前长片的 1 个目录。

结束后 UTC 06:13:12 的只读会话查询仍为同一 session、generation 3、ready/running、error=null，缓存源区间为 1785–1926 秒。此查询没有改变播放状态。

## 播放器卸载后的回收

用户界面返回作品页卸载播放器后，于 UTC 06:13:56.566 只读采样确认 **FFmpeg=0、FFprobe=0**，进程列表只剩 uvicorn，临时文件数为 0。容器匿名内存降至 88.36 MiB。完整分片仍按关闭会话宽限保留，后续硬配额或定期回收负责删除；采样器没有停止容器。

后续短行为验收全部完成、测试页关闭后，再次确认 FFmpeg/FFprobe 为 0，并按授权执行容器清理。两次 `docker stop` 均正常发送 SIGTERM，后端退出码为 **143**，日志记录应用关闭完成（共 2 次），没有 OOM 或超时强杀；nginx 退出码为 0。短暂重启后健康接口恢复，播放缓存从 7 个会话目录清理为仅 `.worker.lock`（1 字节），验证独占锁释放及启动残留回收。随后正常停止并删除本任务的两个容器及经核实无其他成员的两个专有网络，33100 端口已关闭。合成片、测试数据库、原始证据和镜像均保留，用户开发服务未操作。

## 数据与范围

- 精简机器记录：[video-playback-container-stability.json](video-playback-container-stability.json)。包含原始文件路径和 SHA-256。
- 原始逐样本记录：`.cache\playback-browser-stability\observation-20261020-054246.jsonl`。
- 实时及最终摘要：`.cache\playback-browser-stability\observation-20261020-054246.summary.json`。
- 卸载后记录：`.cache\playback-browser-stability\post-close-resource.json`。
- 采样程序：[observe_playback_container.py](../scripts/observe_playback_container.py)。只执行只读 docker exec，采样期间没有发送播放控制或停止服务。
- [NVENC 连续编码及独立 HLS 分片](video-playback-hardware.md) 使用单独的 Windows 硬件测试，其范围与本次 Linux libx264 浏览器播放区分。

资源采样未单独测量 Chrome RSS；宿主 GPU 遥测由多个进程共享，不能据此声称获得浏览器独占 GPU 用量。FFmpeg 数量为每 15 秒采样值。缓存逻辑字节包含完整分片、临时文件、旧代次和关闭会话宽限缓存；磁盘 FFmpeg 清单条目不等同于 API 内存中的已登记区间。容器 cgroup 内存还包含文件页缓存，应与进程 RSS 分开解读。
