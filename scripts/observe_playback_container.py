r"""只读采样专有播放容器；不启动或停止服务，不发送播放控制请求。

PowerShell（收到测试 START 后执行）：
  & backend\.venv\Scripts\python.exe scripts\observe_playback_container.py

每 15 秒执行一次 docker exec 的只读 sampler，持续 1800 秒，每分钟输出摘要。
JSONL 保留原始样本；summary JSON 原子更新，包含预热后前/后 10 分钟 RSS 统计。
"""

from __future__ import annotations

import argparse
import json
import statistics
import subprocess
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
MIB = 1024**2


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def process_metrics(sample: dict[str, Any]) -> dict[str, Any]:
    processes = sample.get("processes", [])
    backend_pid = sample.get("backend_container_pid", 7)
    backend = next((process for process in processes
                    if process["container_pid"] == backend_pid), {})
    ffmpeg = [process for process in processes if process.get("name", "").lower()
              in {"ffmpeg", "ffmpeg.exe"}]
    ffprobe = [process for process in processes if process.get("name", "").lower()
               in {"ffprobe", "ffprobe.exe"}]
    return {
        "backend_rss": backend.get("rss"), "backend_vms": backend.get("vms"),
        "backend_threads": backend.get("threads"),
        "backend_cpu_seconds": backend.get("cpu_user_seconds", 0)
                               + backend.get("cpu_system_seconds", 0),
        "ffmpeg_count": len(ffmpeg), "ffprobe_count": len(ffprobe),
        "ffmpeg_rss": sum(process.get("rss", 0) for process in ffmpeg),
        "all_process_rss": sum(process.get("rss", 0) for process in processes),
    }


def window_stats(samples: list[dict], start: float, end: float, metric: str) -> dict | None:
    values = [(row["elapsed_seconds"], row["metrics"][metric]) for row in samples
              if start <= row["elapsed_seconds"] <= end and row["metrics"].get(metric) is not None]
    if not values:
        return None
    numbers = [value for _, value in values]
    mean_time = statistics.mean(moment for moment, _ in values)
    mean_value = statistics.mean(numbers)
    denominator = sum((moment - mean_time) ** 2 for moment, _ in values)
    slope = (sum((moment - mean_time) * (value - mean_value) for moment, value in values)
             / denominator * 60 if denominator else 0)
    return {
        "samples": len(values), "start_elapsed_seconds": values[0][0],
        "end_elapsed_seconds": values[-1][0], "mean_bytes": round(mean_value),
        "median_bytes": statistics.median(numbers), "min_bytes": min(numbers),
        "max_bytes": max(numbers), "first_bytes": numbers[0], "last_bytes": numbers[-1],
        "slope_bytes_per_minute": round(slope),
    }


def summary(rows: list[dict], *, duration: float, warmup: float, complete: bool,
            started_utc: str) -> dict:
    samples = [row for row in rows if row.get("ok")]
    elapsed = rows[-1]["elapsed_seconds"] if rows else 0
    result: dict[str, Any] = {
        "started_utc": started_utc, "updated_utc": utc_now(), "complete": complete,
        "target_duration_seconds": duration, "last_sample_elapsed_seconds": elapsed,
        "attempts": len(rows), "successful_samples": len(samples),
        "errors": [{"elapsed_seconds": row["elapsed_seconds"], "error": row.get("error")}
                   for row in rows if not row.get("ok")],
        "warmup_seconds": warmup,
        "notes": ["RSS comes from processes; cgroup memory also includes file cache.",
                  "Cache bytes include complete, temporary, and retired-generation files.",
                  "FFmpeg count is sampled every interval, not a continuous process audit.",
                  "Disk playlist entries are not the API in-memory segment registry."],
    }
    if not samples:
        return result
    max_count = max(row["metrics"]["ffmpeg_count"] for row in samples)
    caches = [row["sample"].get("cache", {}) for row in samples]
    first_window_end = min(warmup + 600, elapsed)
    last_window_start = max(warmup, elapsed - 600)
    result.update({
        "backend_rss_first_after_warmup_10min": window_stats(
            samples, warmup, first_window_end, "backend_rss",
        ),
        "backend_rss_last_after_warmup_10min": window_stats(
            samples, last_window_start, elapsed, "backend_rss",
        ),
        "ffmpeg_rss_first_after_warmup_10min": window_stats(
            samples, warmup, first_window_end, "ffmpeg_rss",
        ),
        "ffmpeg_rss_last_after_warmup_10min": window_stats(
            samples, last_window_start, elapsed, "ffmpeg_rss",
        ),
        "max_ffmpeg_count": max_count,
        "ffmpeg_count_within_one_at_all_samples": max_count <= 1,
        "ffmpeg_count_over_one_samples": [row["elapsed_seconds"] for row in samples
                                           if row["metrics"]["ffmpeg_count"] > 1],
        "cache_peak_bytes": max(cache.get("bytes", 0) for cache in caches),
        "cache_last_bytes": caches[-1].get("bytes"),
        "cache_peak_allocated_bytes": max(
            (cache["allocated_bytes"] for cache in caches
             if cache.get("allocated_bytes") is not None), default=None,
        ),
        "cache_last_segments": caches[-1].get("segments"),
        "cache_peak_segments": max(cache.get("segments", 0) for cache in caches),
        "last_metrics": samples[-1]["metrics"],
        "last_cgroup_memory_breakdown": samples[-1]["sample"].get("cgroup_memory_breakdown"),
    })
    return result


def write_summary(path: Path, value: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def brief(value: dict) -> str:
    last = value.get("last_metrics", {})
    rss = last.get("backend_rss")
    cache = value.get("cache_last_bytes")
    return (
        f"[{value['updated_utc']}] 已采样 {value['last_sample_elapsed_seconds']:.0f}s；"
        f"成功 {value['successful_samples']}/{value['attempts']}；"
        f"后端 RSS {rss / MIB:.1f} MiB；缓存 {cache / MIB:.1f} MiB；"
        f"FFmpeg {last.get('ffmpeg_count', '?')}，峰值 {value.get('max_ffmpeg_count', '?')}"
        if rss is not None and cache is not None else
        f"[{value['updated_utc']}] 暂无成功资源样本；尝试 {value['attempts']} 次"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--container", default="mooncell-playback-stability-backend")
    parser.add_argument("--sampler", default="/validation/sample_backend.py")
    parser.add_argument("--duration", type=float, default=1800)
    parser.add_argument("--interval", type=float, default=15)
    parser.add_argument("--summary-interval", type=float, default=60)
    parser.add_argument("--warmup", type=float, default=120)
    parser.add_argument("--timeout", type=float, default=20)
    parser.add_argument("--output", type=Path)
    options = parser.parse_args()
    if (options.duration < 0 or options.interval <= 0 or options.summary_interval <= 0
            or options.timeout <= 0 or options.warmup < 0):
        parser.error("时长不能为负，采样间隔、摘要间隔和命令超时必须大于零")
    destination = options.output or (
        ROOT / ".cache" / "playback-browser-stability"
        / f"observation-{datetime.now(UTC).strftime('%Y%m%d-%H%M%S')}.jsonl"
    )
    destination = destination.resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    summary_path = destination.with_suffix(".summary.json")
    rows = []
    started_utc, started = utc_now(), time.monotonic()
    next_sample, next_summary = 0.0, 0.0
    print(json.dumps({"event": "started", "utc": started_utc, "output": str(destination),
                      "summary": str(summary_path), "container": options.container,
                      "duration_seconds": options.duration}, ensure_ascii=False), flush=True)
    with destination.open("x", encoding="utf-8", buffering=1) as log:
        while True:
            scheduled = min(next_sample, options.duration)
            delay = started + scheduled - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            elapsed = round(time.monotonic() - started, 3)
            row: dict[str, Any] = {"utc": utc_now(), "elapsed_seconds": elapsed,
                                   "scheduled_seconds": scheduled}
            try:
                command = ["docker", "exec", options.container, "python", options.sampler]
                completed = subprocess.run(command, capture_output=True, text=True,
                                           encoding="utf-8", timeout=options.timeout, check=False)
                if completed.returncode:
                    raise RuntimeError(completed.stderr.strip()[-2000:]
                                       or f"docker exec 返回 {completed.returncode}")
                sample = json.loads(completed.stdout)
                row.update(ok=True, sample=sample, metrics=process_metrics(sample))
            except (OSError, subprocess.SubprocessError, RuntimeError, ValueError, KeyError) as exc:
                row.update(ok=False, error=f"{type(exc).__name__}: {exc}")
            row["sample_command_seconds"] = round(time.monotonic() - started - elapsed, 3)
            log.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
            rows.append(row)
            complete = scheduled >= options.duration
            value = summary(rows, duration=options.duration, warmup=options.warmup,
                            complete=complete, started_utc=started_utc)
            write_summary(summary_path, value)
            if elapsed >= next_summary or complete:
                print(brief(value), flush=True)
                next_summary = (int(elapsed / options.summary_interval) + 1
                                ) * options.summary_interval
            if complete:
                print(json.dumps({"event": "complete", "summary": str(summary_path),
                                  "successful_samples": value["successful_samples"],
                                  "errors": len(value["errors"])}, ensure_ascii=False), flush=True)
                return 0 if not value["errors"] else 1
            next_sample += options.interval
            # 慢命令不并发堆积；原始记录保留实际延迟，最后仍采到目标时长。
            while next_sample < time.monotonic() - started:
                next_sample += options.interval


if __name__ == "__main__":
    raise SystemExit(main())
