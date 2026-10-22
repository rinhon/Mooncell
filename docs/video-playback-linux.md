# Linux 容器播放验证

验证日期：2026-10-20，13:22:59–13:23:36（北京时间）。结果：最终冻结代码的 4 组检查全部通过，验证容器退出码为 0，任务容器已删除。

环境为 Docker Desktop 的 `linux/amd64` 容器，镜像 `mooncell-playback-test`，镜像摘要 `sha256:2f8dafff98ed883699caef664c57290cf8a0d4a2f0fd1ee7fc1f9e61118295c7`。镜像来自 `backend\Dockerfile`，额外只读挂载当前 `backend\app`，使验证使用构建之后完成修复的业务代码。编码器为 `libx264`。

脚本：[validate_playback_linux.py](../scripts/validate_playback_linux.py)。原始记录：[video-playback-linux-result.json](video-playback-linux-result.json)。所有样本、数据库、分片都在项目 `.cache\playback-linux-validation\run-5` 中生成，没有访问实际媒体库。容器禁用外网，使用 `--init` 回收退出进程。

## 实测结果

| 检查 | 结果与证据 |
| --- | --- |
| FFmpeg 挂起与恢复 | `OwnedProcess` 启动实时合成源；挂起后 Linux 状态为 `stopped`，媒体输出时钟保持；恢复后输出从 0.583333 秒增长到 0.958333 秒 |
| 暂停状态关闭 | 再次挂起 FFmpeg 后调用 `OwnedProcess.stop()`，确认恢复并正常退出，退出码 0，无存活进程 |
| 父进程异常退出 | 父进程执行 `os._exit(23)`，跳过 Python 清理；FFmpeg 由 `PR_SET_PDEATHSIG/SIGKILL` 终止，容器 init 完成回收 |
| 媒体探测 | 24 秒 MP4/H.264/AAC 正确识别 1 条音轨；18 秒 MKV/HEVC 和 180 秒 MP4/H.264 正确识别为无音轨；全部为 SDR |
| Cookie 鉴权 | 通过生产认证路由完成初始化、退出及重新登录；Cookie 带 `HttpOnly`；未登录媒体信息和 HLS 访问返回 401 |
| HLS 转码与读取 | 三个样本均生成 MPEG-TS 分片，经同源鉴权接口读取，并再次使用 FFmpeg 实际解码成功；响应使用 `Cache-Control: no-store` |
| 缓存内 seek | 两个短片完整产出后跳转至 7.3 秒，保持代次 1 并更新源位置，原资源地址仍返回 200 |
| 缓存外 seek | 180 秒样本从源时间 0 起播，跳转至超出约 90 秒领先窗口的 160.3 秒；新首片源视频 PTS 为 160.333333 秒，符合 24 fps 帧边界；代次由 1 更新为 2 |
| ENDLIST 与完整尾片 | 两个短片分别完整发布 8、6 个分片；180 秒样本跳转后发布 7 片。均核对 `#EXT-X-ENDLIST` 存在，且 `EXTINF` 总和与剩余源时长误差小于 0.25 秒 |
| 旧资源隔离 | 缓存外 seek 后旧清单、旧分片均返回 409；退出登录后的当前清单返回 401 |
| 幂等、暂停与续播 | 重复创建请求返回同一会话；暂停/恢复心跳成功；进度分别持久化为 8.3、8.3、161.3 秒，代次不匹配的写入返回 409 |
| 字幕与能力 | 外置 UTF-8 SRT 经鉴权接口返回 WebVTT；FFmpeg、FFprobe 可用，`libx264` 实际编码自检通过 |

音频 MP4 首片为 154,912 字节，静音 MKV 首片为 109,228 字节，长静音 MP4 首片为 104,152 字节。完整 HTTP 检查组约 27.4 秒，包含三个样本的多次登录、探测、转码、两种 seek、取片、解码、末片完整性和关闭；该数值不是首帧或 seek 延迟指标。

HTTP 验证在容器内 `127.0.0.1:18766` 启动生产认证、媒体与播放路由，使用真实数据库、FFmpeg 和 `SessionManager`。本项覆盖后端 Linux 行为；前端浏览器、Compose 入口、HTTPS、WebGPU 与硬件编码器由对应专项记录说明。

## 复现

使用全新专有目录，避免复用上次验证数据库。以下命令从项目根目录运行，`run-6` 可改为新的任务目录名。关闭继承自镜像的 8000 端口探活，因为验证 HTTP 服务使用独立的 18766 端口。

```powershell
New-Item -ItemType Directory -Path 'F:\code\mooncell\.cache\playback-linux-validation\run-6' -Force | Out-Null

docker run --init --name mooncell-playback-linux-validation --no-healthcheck --network none `
  --mount 'type=bind,source=F:\code\mooncell\.cache\playback-linux-validation\run-6,target=/validation' `
  --mount 'type=bind,source=F:\code\mooncell\scripts\validate_playback_linux.py,target=/validation-script.py,readonly' `
  --mount 'type=bind,source=F:\code\mooncell\backend\app,target=/app/app,readonly' `
  mooncell-playback-test python /validation-script.py --work /validation

docker inspect --format '{{.State.ExitCode}}' mooncell-playback-linux-validation
docker rm mooncell-playback-linux-validation
```

应得到 4 项 `passed: true` 和容器退出码 `0`。JSON 记录保存在该次专有目录的 `linux-validation.json`；删除任务容器不会删除绑定目录或镜像缓存。
