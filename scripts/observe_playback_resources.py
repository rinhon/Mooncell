"""只读采样正在运行的播放服务资源，不启动、暂停或终止任何进程。"""

import argparse
import json
import time
from datetime import UTC, datetime
from pathlib import Path

import psutil


def observe(server_pid: int, cache: Path, output: Path, duration: float, interval: float):
    started = time.monotonic()
    samples = []
    server = psutil.Process(server_pid)
    created = server.create_time()
    output.parent.mkdir(parents=True, exist_ok=True)
    while True:
        if not server.is_running() or server.create_time() != created:
            raise RuntimeError("采样服务已退出或 PID 已复用")
        children = [child for child in server.children(recursive=True)
                    if child.name().lower() in {"ffmpeg", "ffmpeg.exe"}]
        sample = {
            "elapsed_seconds": round(time.monotonic() - started, 2),
            "utc": datetime.now(UTC).isoformat(),
            "server_rss_bytes": server.memory_info().rss,
            "ffmpeg_count": len(children),
            "ffmpeg_rss_bytes": sum(child.memory_info().rss for child in children),
            "cache_bytes": sum(path.stat().st_size for path in cache.rglob("*")
                               if path.is_file() and not path.is_symlink()),
        }
        samples.append(sample)
        output.write_text(json.dumps({"server_pid": server_pid, "duration_seconds": duration,
                                      "samples": samples}, indent=2), encoding="utf-8")
        if sample["elapsed_seconds"] >= duration:
            print(json.dumps({"output": str(output), "samples": len(samples),
                              "elapsed_seconds": sample["elapsed_seconds"],
                              "max_ffmpeg_count": max(item["ffmpeg_count"] for item in samples),
                              "max_cache_bytes": max(item["cache_bytes"] for item in samples),
                              "server_rss_first": samples[0]["server_rss_bytes"],
                              "server_rss_last": sample["server_rss_bytes"]}), flush=True)
            return
        time.sleep(min(interval, max(0.01, duration - (time.monotonic() - started))))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server-pid", type=int, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--duration", type=float, default=1800)
    parser.add_argument("--interval", type=float, default=15)
    args = parser.parse_args()
    observe(args.server_pid, args.cache, args.output, max(1, args.duration), max(1, args.interval))
