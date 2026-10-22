"""使用服务自有进程管理器执行一次实时 NVENC 稳定性验证，不生成视频文件。"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import shutil
import subprocess
import sys
import time
import uuid
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import psutil

from app.playback.processes import OwnedProcess


class CountedDecoder(OwnedProcess):
    """沿用自有进程保护，额外读取 FFmpeg 实际解码帧数。"""

    def __init__(self):
        super().__init__()
        self.frames = 0

    def _stdout(self) -> None:
        assert self.process and self.process.stdout
        for line in self.process.stdout:
            key, _, value = line.strip().partition("=")
            try:
                if key == "frame":
                    self.frames = int(value)
                elif key == "out_time_us":
                    self.out_time = float(value) / 1_000_000
                    self.last_progress = time.monotonic()
            except ValueError:
                pass


async def gpu_reading() -> dict | None:
    command = shutil.which("nvidia-smi")
    if not command:
        return None
    try:
        result = await asyncio.to_thread(
            subprocess.run,
            [command, ("--query-gpu=name,utilization.gpu,utilization.encoder,"
                       "utilization.decoder,memory.used"), "--format=csv,noheader,nounits"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=5,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return {"returncode": result.returncode, "csv": result.stdout.strip()[:2000]}
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"error": type(error).__name__}


async def validate(args) -> int:
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    executable = shutil.which(args.ffmpeg)
    if executable is None:
        raise SystemExit("找不到 FFmpeg")
    command = [
        executable, "-hide_banner", "-loglevel", "warning", "-nostats", "-progress", "pipe:1",
        "-stats_period", "1", "-threads", "2", "-re", "-f", "lavfi", "-i",
        "testsrc2=size=1280x720:rate=24", "-f", "lavfi", "-i",
        "sine=frequency=440:sample_rate=48000", "-t", str(args.seconds), "-map", "0:v:0",
        "-map", "1:a:0", "-c:v", "h264_nvenc", "-preset", "p3", "-rc", "vbr", "-cq", "23",
        "-b:v", "4500k", "-maxrate", "6000k", "-bufsize", "12000k", "-pix_fmt", "yuv420p",
        "-g", "72", "-c:a", "aac", "-ac", "2", "-ar", "48000", "-b:a", "128k",
        "-f", "null", "-",
    ]
    process = OwnedProcess()
    started = time.monotonic()
    date = datetime.now(UTC)
    metadata = {
        "requested_seconds": args.seconds, "interval_seconds": args.interval,
        "started_utc": date.isoformat(),
        "started_shanghai": date.astimezone(timezone(timedelta(hours=8))).isoformat(),
        "command": command, "samples": [], "state": "starting", "passed": False,
        "parallel_gpu_workload": "与同机浏览器普通播放及 Anime4K 持续验收并行；GPU 未隔离",
    }
    status_path = output / "status.json"

    def save() -> None:
        status_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")

    save()
    error_text = None
    try:
        process.start(command)
        tracked = psutil.Process(process.process.pid)
        tracked.cpu_percent()
        metadata.update(pid=process.process.pid, windows_job_protected=process.job is not None,
                        state="running")
        print(json.dumps({key: value for key, value in metadata.items() if key != "samples"},
                         ensure_ascii=False), flush=True)
        previous_wall, previous_time = started, 0.0
        printed_at = -60.0
        while True:
            now = time.monotonic()
            elapsed = now - started
            try:
                memory = tracked.memory_info()
                rss = memory.rss
                peak = getattr(memory, "peak_wset", rss)
                cpu = tracked.cpu_percent()
            except psutil.Error:
                rss = peak = cpu = None
            sample = {
                "elapsed_seconds": round(elapsed, 3), "source_seconds": process.out_time,
                "interval_speed": round((process.out_time - previous_time)
                                        / max(0.001, now - previous_wall), 4),
                "rss_bytes": rss, "peak_rss_bytes": peak, "cpu_percent": cpu,
                "returncode": process.returncode, "gpu": await gpu_reading(),
            }
            metadata["samples"].append(sample)
            metadata.update(wall_elapsed_seconds=round(elapsed, 3), source_seconds=process.out_time)
            with (output / "samples.jsonl").open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(sample, ensure_ascii=False) + "\n")
            save()
            if elapsed - printed_at >= 60 or process.returncode is not None:
                print(json.dumps(sample, ensure_ascii=False), flush=True)
                printed_at = elapsed
            if process.returncode is not None:
                break
            if elapsed > args.seconds + 120:
                raise RuntimeError("超过实时目标与 120 秒退出宽限，未完成目标源时间")
            if now - process.last_progress > 45:
                raise RuntimeError("FFmpeg 超过 45 秒未报告进度")
            previous_wall, previous_time = now, process.out_time
            await asyncio.sleep(args.interval)
        metadata["passed"] = process.returncode == 0 and process.out_time >= args.seconds - 0.5
        metadata["state"] = "passed" if metadata["passed"] else "failed"
    except asyncio.CancelledError:
        error_text = "验证被中断，已收割本次自建 FFmpeg"
        metadata["state"] = "interrupted"
        raise
    except Exception as error:  # noqa: BLE001 验证器记录失败并统一收割自建进程。
        error_text = f"{type(error).__name__}: {error}"
        metadata["state"] = "failed"
    finally:
        await asyncio.shield(process.stop())
        metadata.update(exitcode=process.returncode, source_seconds=process.out_time,
                        wall_elapsed_seconds=round(time.monotonic() - started, 3),
                        finished_utc=datetime.now(UTC).isoformat(),
                        stderr_tail=list(process.stderr),
                        error=error_text)
        readings = [item["rss_bytes"] for item in metadata["samples"] if item["rss_bytes"]]
        if readings:
            metadata.update(rss_min_bytes=min(readings), rss_max_bytes=max(readings),
                            rss_final_bytes=readings[-1])
        save()
        (output / "stderr-tail.txt").write_text("\n".join(process.stderr), encoding="utf-8")
        print(json.dumps({key: value for key, value in metadata.items() if key != "samples"},
                         ensure_ascii=False), flush=True)
    return 0 if metadata["passed"] else 1


async def validate_hardware_hls(args) -> int:
    from app.config import settings
    from app.playback.media import ResolvedMedia, file_version
    from app.playback.probe import probe_media, run_media_command, shutdown_probes
    from app.playback.sessions import SessionManager

    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    source = output / "synthetic-12s.mp4"
    # 这些设置只存在于本验证子进程，不读取/修改开发服务的会话或缓存。
    settings.playback_encoder = "h264_nvenc"
    settings.playback_cache_path = str(output / "hls-cache")
    settings.playback_min_free_mb = 0
    settings.playback_threads = 2
    manager = SessionManager()
    owned = None
    result = {"passed": False, "encoder": "h264_nvenc", "source_duration": 12,
              "segments": [], "started_utc": datetime.now(UTC).isoformat()}
    try:
        await run_media_command([
            args.ffmpeg, "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i",
            "testsrc2=size=1280x720:rate=24", "-f", "lavfi", "-i",
            "sine=frequency=440:sample_rate=48000", "-t", "12", "-c:v", "libx264",
            "-preset", "ultrafast", "-threads", "2", "-pix_fmt", "yuv420p", "-c:a",
            "aac", "-ac", "2", "-ar", "48000", "-b:a", "128k", str(source),
        ], 30)
        stat = source.stat()
        version = file_version(source.name, stat.st_size, stat.st_mtime_ns)
        media = ResolvedMedia("c" * 64, 775566, source, version, stat.st_size, stat.st_mtime_ns,
                              output, output, source.name)
        info = await probe_media(media)
        await manager.start()
        created = await manager.create(1, media, info, 0, 720, None, str(uuid.uuid4()))
        current = manager.get(1, created["id"])
        async with asyncio.timeout(45):
            while not current.ended:
                if current.process:
                    owned = current.process
                if current.status == "failed":
                    raise RuntimeError(str(current.error))
                await asyncio.sleep(0.1)
        playlist = await manager.playlist(1, current.id, current.generation)
        assert "#EXT-X-ENDLIST" in playlist
        result["playlist"] = playlist
        for segment in sorted(current.segments.values(), key=lambda item: item.sequence):
            decoder = CountedDecoder()
            try:
                decoder.start([
                    args.ffmpeg, "-hide_banner", "-loglevel", "error", "-nostats",
                    "-progress", "pipe:1", "-threads", "2", "-xerror", "-err_detect", "explode",
                    "-i", str(segment.path), "-f", "null", "-",
                ])
                async with asyncio.timeout(20):
                    while decoder.running:
                        await asyncio.sleep(0.05)
            finally:
                await decoder.stop()
            expected_frames = round(segment.duration * info.frame_rate)
            record = {"sequence": segment.sequence, "source_start": segment.source_start,
                      "duration": segment.duration, "bytes": segment.path.stat().st_size,
                      "decoded_frames": decoder.frames, "expected_frames": expected_frames,
                      "decode_exitcode": decoder.returncode, "stderr_tail": list(decoder.stderr)}
            result["segments"].append(record)
            assert decoder.returncode == 0 and decoder.frames >= expected_frames - 1, record
        assert len(result["segments"]) == 4
        assert all(abs(item["duration"] - 3) < 0.001 for item in result["segments"])
        total_decoded_frames = sum(item["decoded_frames"] for item in result["segments"])
        assert total_decoded_frames == 288
        assert abs(sum(item["duration"] for item in result["segments"]) - info.duration) < 0.1
        result.update(passed=True, encoded_exitcode=owned.returncode if owned else None,
                      encoder_stderr_tail=list(owned.stderr) if owned else [],
                      total_decoded_frames=total_decoded_frames)
    except Exception as error:  # noqa: BLE001 记录失败并统一清理测试自有进程及缓存。
        result["error"] = f"{type(error).__name__}: {error}"
        result["encoder_stderr_tail"] = list(owned.stderr) if owned else []
    finally:
        await manager.shutdown()
        await shutdown_probes()
        for session in list(manager.sessions.values()):
            await manager._cleanup(session)
        source.unlink(missing_ok=True)
        result["finished_utc"] = datetime.now(UTC).isoformat()
        (output / "nvenc-hls-result.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8",
        )
        print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0 if result["passed"] else 1


async def sample_browser_gpu_tail(args) -> int:
    until = datetime.fromisoformat(args.gpu_tail_until).astimezone(UTC)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    target = output / "gpu-browser-tail.jsonl"
    while True:
        now = datetime.now(UTC)
        sample = {"utc": now.isoformat(), "gpu": await gpu_reading(),
                  "test_encoder_running": False}
        with target.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(sample, ensure_ascii=False) + "\n")
        print(json.dumps(sample, ensure_ascii=False), flush=True)
        if now >= until:
            return 0
        await asyncio.sleep(min(30, max(0.01, (until - now).total_seconds())))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--seconds", type=int, default=1800)
    parser.add_argument("--interval", type=float, default=15)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--output", type=Path, required=True)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--hls-smoke", action="store_true")
    modes.add_argument("--gpu-tail-until")
    arguments = parser.parse_args()
    if arguments.seconds < 1 or not 1 <= arguments.interval <= 60:
        parser.error("seconds 必须大于 0，interval 必须在 1–60 秒之间")
    with contextlib.suppress(KeyboardInterrupt):
        if arguments.hls_smoke:
            raise SystemExit(asyncio.run(validate_hardware_hls(arguments)))
        if arguments.gpu_tail_until:
            raise SystemExit(asyncio.run(sample_browser_gpu_tail(arguments)))
        raise SystemExit(asyncio.run(validate(arguments)))
