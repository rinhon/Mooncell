r"""播放服务端基准；默认在 .cache 内合成媒体，使用隔离 SessionManager。

PowerShell:
  & backend\.venv\Scripts\python.exe scripts\benchmark_playback_seek.py --rounds 30

ready、HTTP 首字节、分片下载均不是浏览器目标帧呈现时间。
HTTP 模式使用显式指定的测试媒体或会话，Cookie 仅从环境变量读取。
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import inspect
import json
import math
import os
import platform
import re
import shutil
import subprocess
import sys
import time
import uuid
from datetime import UTC, datetime
from fractions import Fraction
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode, urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[1]
OUTPUT_ROOT = ROOT / ".cache" / "playback-seek-benchmark"
USER_ID = 2147483000


def elapsed_ms(start: float) -> float:
    return round((time.perf_counter() - start) * 1000, 3)


def command_output(command: list[str], timeout: float = 120) -> str:
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8",
                            errors="replace", timeout=timeout, check=False)
    if result.returncode:
        raise RuntimeError(f"{Path(command[0]).name} 退出 {result.returncode}: "
                           f"{result.stderr[-1800:]}")
    return result.stdout


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    index = (len(ordered) - 1) * fraction
    low, high = math.floor(index), math.ceil(index)
    return round(ordered[low] + (ordered[high] - ordered[low]) * (index - low), 3)


def summarize(rows: list[dict]) -> dict:
    summary = {}
    for scenario in ("create", "cached_seek", "cold_seek"):
        selected = [row for row in rows if row["scenario"] == scenario]
        successful = [row for row in selected if row["status"] == "ok"]
        failures = sum(row["status"] == "failed" for row in selected)
        attempted = len(successful) + failures
        names = sorted({key for row in successful for key in row.get("metrics", {})})
        metrics = {}
        for name in names:
            values = [row["metrics"][name] for row in successful
                      if isinstance(row.get("metrics", {}).get(name), (int, float))]
            if values:
                metrics[name] = {"samples": len(values), "p50": percentile(values, .5),
                                 "p95": percentile(values, .95), "max": max(values)}
        summary[scenario] = {"successful": len(successful), "failed": failures,
                             "skipped": len(selected) - attempted,
                             "failure_rate": round(failures / attempted, 6) if attempted else None,
                             "metrics_ms": metrics}
    return summary


def snapshot_excerpt(snapshot: dict) -> dict:
    keys = ("id", "generation", "revision", "seek_revision", "status", "source_anchor",
            "quality", "audio_track", "cached_ranges", "timings", "seek_disposition",
            "requires_reload", "playback_mode", "error")
    value = {key: snapshot[key] for key in keys if key in snapshot}
    value["segment_count"] = len(snapshot.get("segments", []))
    return value


def cached_target(snapshot: dict) -> float:
    segments = snapshot.get("segments", [])
    if not segments:
        raise RuntimeError("会话没有已登记分片，不能测量服务端缓存命中")
    first = segments[0]
    return first["source_start"] + min(.5, first["duration"] / 2)


def cold_target(snapshot: dict, requested: float | None) -> float:
    duration = float(snapshot["duration"])
    candidates = [requested] if requested is not None else [duration * .8, duration * .2,
                                                           max(0, duration - 1)]
    ranges = snapshot.get("cached_ranges", [])
    for candidate in candidates:
        if candidate is not None and 0 <= candidate < duration - .1 and not any(
                start <= candidate < end for start, end in ranges):
            return candidate
    raise RuntimeError("候选冷跳目标均已缓存；请使用更长测试片或指定未缓存的 --cold-target")


class ManagerClient:
    """直接调用生产会话管理器；不初始化数据库，不注册媒体库条目。"""

    def __init__(self, options, directory: Path):
        self.options, self.directory = options, directory
        self.manager = None
        self.media = self.info = None
        self.supports_wait = False
        self.metadata: dict = {}

    async def start(self) -> None:
        sys.path.insert(0, str(ROOT / "backend"))
        from app.config import settings
        from app.playback.media import ResolvedMedia, file_version
        from app.playback.probe import parse_probe
        from app.playback.sessions import SessionManager

        # 仅本脚本进程内更改配置，绝不复用服务运行中的缓存根。
        settings.playback_cache_path = str(self.directory / "sessions")
        settings.playback_encoder = self.options.encoder
        settings.playback_min_free_mb = 0
        settings.playback_max_sessions = 1
        settings.playback_session_quota_mb = 512
        settings.playback_global_quota_mb = 1024
        settings.playback_threads = self.options.threads
        ffmpeg, ffprobe = settings.playback_ffmpeg, settings.playback_ffprobe
        if not shutil.which(ffmpeg) or not shutil.which(ffprobe):
            raise RuntimeError("需要已安装且在 PATH 中的 FFmpeg/FFprobe")
        self.metadata["ffmpeg_version"] = command_output([ffmpeg, "-version"]).splitlines()[0]
        self.metadata["ffprobe_version"] = command_output([ffprobe, "-version"]).splitlines()[0]
        path = self.options.media.resolve() if self.options.media else self.directory / "sample.mp4"
        generated = self.options.media is None
        if generated:
            width, height = self.options.size.split("x")
            command_output([
                ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi",
                "-i", f"testsrc2=size={width}x{height}:rate={self.options.frame_rate}",
                "-f", "lavfi",
                "-i", "sine=frequency=440:sample_rate=48000", "-t", str(self.options.duration),
                "-c:v", "libx264", "-preset", "ultrafast", "-threads", str(self.options.threads),
                "-g", "120", "-keyint_min", "120", "-sc_threshold", "0", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "64k", "-ac", "2", "-movflags", "+faststart", str(path),
            ])
        stat = path.stat()
        version = file_version(path.name, stat.st_size, stat.st_mtime_ns)
        self.media = ResolvedMedia(uuid.uuid4().hex * 2, USER_ID, path, version, stat.st_size,
                                   stat.st_mtime_ns, path.parent, path.parent, path.name)
        probe_started = time.perf_counter()
        payload = json.loads(command_output([
            ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path),
        ]))
        self.info = parse_probe(self.media, payload)
        self.metadata.update({"source": {"path": str(path), "generated": generated,
                                         "bytes": stat.st_size, "version": version,
                                         "probe": self.info.model_dump(mode="json")},
                              "metadata_probe_ms": elapsed_ms(probe_started),
                              "encoder": settings.playback_encoder,
                              "encoder_metadata_source": "local_process_configuration",
                              "threads": settings.playback_threads,
                              "network": "in_process_manager_no_http",
                              "probe_in_operation_samples": False})
        self.manager = SessionManager()
        self.supports_wait = "after_revision" in inspect.signature(self.manager.status).parameters
        await self.manager.start()

    async def create(self) -> dict:
        assert self.manager and self.media and self.info
        audio = self.info.audio_tracks[0].id if self.info.audio_tracks else None
        return await self.manager.create(USER_ID, self.media, self.info, 0,
                                         self.info.qualities[-1], audio, str(uuid.uuid4()))

    async def seek(self, snapshot: dict, target: float) -> dict:
        return await self.manager.seek(USER_ID, snapshot["id"], snapshot["generation"],
                                       target, str(uuid.uuid4()))

    async def status(self, snapshot: dict, wait_ms: int = 0) -> dict:
        if self.supports_wait and "revision" in snapshot:
            return await self.manager.status(USER_ID, snapshot["id"],
                                              after_revision=snapshot["revision"], wait_ms=wait_ms)
        if wait_ms:
            await asyncio.sleep(self.options.poll_ms / 1000)
        return await self.manager.status(USER_ID, snapshot["id"])

    async def playlist(self, snapshot: dict) -> str:
        return await self.manager.playlist(USER_ID, snapshot["id"], snapshot["generation"])

    async def fetch(self, snapshot: dict, uri: str) -> dict:
        started = time.perf_counter()
        segment = await self.manager.open_segment(USER_ID, snapshot["id"], snapshot["generation"],
                                                   uri.rsplit("/", 1)[-1])
        opened = elapsed_ms(started)
        try:
            def read() -> dict:
                with segment.path.open("rb") as source:
                    first = source.read(1)
                    first_ms = elapsed_ms(started)
                    size = len(first)
                    while chunk := source.read(256 * 1024):
                        size += len(chunk)
                return {"segment_first_byte_ms": first_ms,
                        "segment_download_ms": elapsed_ms(started),
                        "segment_bytes": size, "segment_open_ms": opened}
            return await asyncio.to_thread(read)
        finally:
            await self.manager.release_segment(segment)

    async def close(self, session_id: str) -> None:
        await self.manager.close(USER_ID, session_id)

    async def stop(self) -> None:
        if self.manager:
            await self.manager.shutdown()


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class HttpClient:
    def __init__(self, options, directory: Path):
        self.options = options
        self.base = options.base_url.rstrip("/") + "/"
        self.origin = urlsplit(self.base)[:2]
        self.cookie = os.environ.get(options.cookie_env, "")
        self.opener = build_opener(NoRedirect())
        self.metadata: dict = {"network": options.network_label,
                               "base_url": self.base, "server_label": options.server_label,
                               "encoder": options.encoder,
                               "encoder_metadata_source": "user_declared_not_verified",
                               "cookie_env_name": options.cookie_env,
                               "metadata_probe_ms": None,
                               "probe_in_operation_samples": "server_cache_state_not_controlled"}

    def _url(self, path: str) -> str:
        url = urljoin(self.base, path)
        if urlsplit(url)[:2] != self.origin:
            raise RuntimeError("拒绝将测试鉴权 Cookie 发送到其他 origin")
        return url

    def _request(self, path: str, method="GET", body=None, binary=False):
        headers = {"Accept": "application/json", "User-Agent": "MooncellSeekBenchmark/1"}
        if self.cookie:
            headers["Cookie"] = self.cookie
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode("utf-8")
        started = time.perf_counter()
        try:
            with self.opener.open(Request(self._url(path), data, headers, method=method),
                                  timeout=self.options.timeout) as response:
                first = response.read(1)
                first_ms = elapsed_ms(started)
                if binary:
                    size = len(first)
                    while chunk := response.read(256 * 1024):
                        size += len(chunk)
                    return {"segment_first_byte_ms": first_ms,
                            "segment_download_ms": elapsed_ms(started), "segment_bytes": size}
                payload = first + response.read(8 * 1024 * 1024)
                return payload.decode("utf-8")
        except HTTPError as exc:
            # 不记录请求头、Cookie 或完整请求对象。
            detail = exc.read(1500).decode("utf-8", errors="replace")
            raise RuntimeError(f"HTTP {exc.code}: {detail}") from None

    async def json(self, path: str, method="GET", body=None) -> dict:
        text = await asyncio.to_thread(self._request, path, method, body)
        return json.loads(text) if text else {}

    async def start(self) -> None:
        if not self.cookie:
            raise RuntimeError(f"请将完整 Cookie 请求头值存入环境变量 {self.options.cookie_env}")
        if self.options.media_id:
            self.metadata["source"] = await self.json(
                f"/api/v1/media/{self.options.media_id}/playback-info")
        else:
            self.metadata["source"] = {"existing_session_id": self.options.session_id}

    async def create(self) -> dict:
        info = self.metadata["source"]
        tracks = info.get("audio_tracks", [])
        audio = next((track["id"] for track in tracks if track.get("default")),
                     tracks[0]["id"] if tracks else None)
        return await self.json("/api/v1/playback/sessions", "POST", {
            "media_id": self.options.media_id, "start_time": 0,
            "quality": info.get("qualities", [720])[-1], "audio_track": audio,
            "request_id": str(uuid.uuid4()),
        })

    async def seek(self, snapshot: dict, target: float) -> dict:
        return await self.json(f"/api/v1/playback/sessions/{snapshot['id']}/seek", "POST", {
            "generation": snapshot["generation"], "position": target,
            "request_id": str(uuid.uuid4()),
        })

    async def status(self, snapshot: dict, wait_ms: int = 0) -> dict:
        path = f"/api/v1/playback/sessions/{snapshot['id']}"
        if wait_ms and "revision" in snapshot:
            path += "?" + urlencode({"after_revision": snapshot["revision"], "wait_ms": wait_ms})
        elif wait_ms:
            await asyncio.sleep(self.options.poll_ms / 1000)
        return await self.json(path)

    async def playlist(self, snapshot: dict) -> str:
        return await asyncio.to_thread(self._request, snapshot["playlist_url"])

    async def fetch(self, snapshot: dict, uri: str) -> dict:
        url = urljoin(self._url(snapshot["playlist_url"]), uri)
        return await asyncio.to_thread(self._request, url, "GET", None, True)

    async def close(self, session_id: str) -> None:
        await self.json(f"/api/v1/playback/sessions/{session_id}", "DELETE")

    async def stop(self) -> None:
        pass


async def wait_ready(client, snapshot: dict, timeout: float) -> dict:
    async with asyncio.timeout(timeout):
        while snapshot.get("status") not in {"ready", "paused"}:
            if snapshot.get("status") in {"failed", "closed"}:
                raise RuntimeError(f"会话不可播放: {snapshot_excerpt(snapshot)}")
            snapshot = await client.status(snapshot, 1000)
    return snapshot


async def measure(client, scenario: str, round_number: int, timeout: float,
                  previous: dict | None = None, target: float = 0) -> tuple[dict, dict | None]:
    row: dict = {"scenario": scenario, "round": round_number, "target_seconds": target,
                  "status": "failed", "metrics": {}}
    started = time.perf_counter()
    snapshot = previous
    try:
        snapshot = await (client.create() if scenario == "create"
                          else client.seek(previous, target))
        row["metrics"]["control_response_ms"] = elapsed_ms(started)
        snapshot = await wait_ready(client, snapshot, timeout)
        row["metrics"]["ready_observed_ms"] = elapsed_ms(started)
        row["snapshot"] = snapshot_excerpt(snapshot)
        if scenario == "cached_seek" and snapshot["generation"] != previous["generation"]:
            raise RuntimeError("缓存跳转重建了 generation，不能记作缓存命中")
        if scenario == "cold_seek" and snapshot["generation"] == previous["generation"]:
            raise RuntimeError("冷跳目标在请求前已缓存，不能记作冷跳样本")
        # 当前 timings 属于 generation；缓存 seek 不能复用上一次 create 的耗时。
        if scenario != "cached_seek":
            for key, value in snapshot.get("timings", {}).items():
                if isinstance(value, (int, float)) and math.isfinite(value):
                    row["metrics"][f"server_{key}"] = value
        playlist_started = time.perf_counter()
        playlist = await client.playlist(snapshot)
        row["metrics"]["playlist_ms"] = elapsed_ms(playlist_started)
        entries = [line.strip() for line in playlist.splitlines()
                   if line.strip() and not line.startswith("#")]
        segments = snapshot.get("segments", [])
        if not entries or not segments:
            raise RuntimeError("ready 响应没有可下载的 HLS 分片")
        selected = next((segment for segment in segments
                         if segment["source_start"] <= target < segment["source_start"]
                         + segment["duration"]), segments[0])
        name = f"segment-{selected['sequence']:07d}.ts"
        uri = next((entry for entry in entries if urlsplit(entry).path.endswith('/' + name)
                    or urlsplit(entry).path == name), None)
        if uri is None:
            raise RuntimeError("目标分片不在当前清单内")
        before_fetch = elapsed_ms(started)
        transfer = await client.fetch(snapshot, uri)
        row["segment_bytes"] = transfer.pop("segment_bytes", 0)
        if row["segment_bytes"] <= 0:
            raise RuntimeError("下载到空分片")
        row["metrics"].update(transfer)
        row["metrics"]["operation_to_first_byte_ms"] = round(
            before_fetch + transfer["segment_first_byte_ms"], 3)
        row["metrics"]["operation_to_download_ms"] = elapsed_ms(started)
        row["segment"] = selected
        row["status"] = "ok"
    except Exception as exc:
        row["error"] = f"{type(exc).__name__}: {exc}"
        row["failed_after_ms"] = elapsed_ms(started)
    return row, snapshot


def machine_metadata() -> dict:
    result = {"system": platform.platform(), "python": sys.version, "machine": platform.machine(),
              "processor": platform.processor() or os.environ.get("PROCESSOR_IDENTIFIER"),
              "logical_cpus": os.cpu_count()}
    try:
        import psutil
        result["physical_cpus"] = psutil.cpu_count(logical=False)
        result["ram_bytes"] = psutil.virtual_memory().total
    except ImportError:
        pass
    return result


def code_fingerprints() -> dict[str, str]:
    """记录实际实验前后的源码；不假设并行开发期间工作树静止。"""
    paths = [ROOT / "scripts" / "benchmark_playback_seek.py",
             *(ROOT / "backend" / "app" / "playback").glob("*.py")]
    return {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(paths)}


async def benchmark(options, directory: Path) -> int:
    report = {"schema_version": 1, "started_utc": datetime.now(UTC).isoformat(),
              "complete": False, "mode": options.mode, "rounds_requested": options.rounds,
              "client_machine": machine_metadata(), "rows": [], "summary": {},
              "source_code": {"started": code_fingerprints()},
              "measurement": {
                  "clock": "time.perf_counter on this script host; monotonic; units milliseconds",
                  "clock_info": vars(time.get_clock_info("perf_counter")),
                  "percentile": "linear interpolation at (N-1)*p over successful samples",
                  "ready_is_browser_first_frame": False,
                  "cache_scope": "server segment registry; no browser buffer is exercised",
                  "cold_scope": "not in session segment cache; OS file cache is not cleared",
                  "notes": ["Manager 模式无 HTTP、浏览器或数据库调用。",
                            "HTTP 各环节含客户端网络耗时；服务端 timings 使用服务端自身时钟。",
                            "服务器 ready 与分片首字节均不能用于证明浏览器已呈现目标帧。",
                            "P95 的可靠性取决于样本数量，少轮 smoke 不作为性能验收。"]}}
    output = directory / "report.json"
    client = (ManagerClient(options, directory) if options.mode == "manager"
              else HttpClient(options, directory))

    def save() -> None:
        report["summary"] = summarize(report["rows"])
        report["updated_utc"] = datetime.now(UTC).isoformat()
        temporary = output.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(output)

    save()
    try:
        await client.start()
        report["environment"] = client.metadata
        report["environment"]["network_label"] = options.network_label
        for round_number in range(1, options.rounds + 1):
            snapshot = None
            owned_session = not (options.mode == "http" and options.session_id)
            try:
                if owned_session:
                    row, snapshot = await measure(client, "create", round_number, options.timeout)
                else:
                    snapshot = await client.json(f"/api/v1/playback/sessions/{options.session_id}")
                    snapshot = await wait_ready(client, snapshot, options.timeout)
                    row = {"scenario": "create", "round": round_number, "status": "skipped",
                           "reason": "使用已有会话，不伪造创建测量"}
                report["rows"].append(row)
                save()
                if row["status"] == "failed" or snapshot is None:
                    for scenario in ("cached_seek", "cold_seek"):
                        report["rows"].append({"scenario": scenario, "round": round_number,
                                               "status": "skipped", "reason": "创建失败"})
                    continue
                target = cached_target(snapshot)
                row, snapshot = await measure(client, "cached_seek", round_number, options.timeout,
                                                snapshot, target)
                report["rows"].append(row)
                save()
                try:
                    target = cold_target(snapshot, options.cold_target)
                except RuntimeError as exc:
                    report["rows"].append({"scenario": "cold_seek", "round": round_number,
                                           "status": "skipped", "reason": str(exc)})
                else:
                    row, snapshot = await measure(client, "cold_seek", round_number,
                                                    options.timeout,
                                                    snapshot, target)
                    report["rows"].append(row)
            finally:
                if owned_session and snapshot and snapshot.get("id"):
                    await client.close(snapshot["id"])
                save()
            print(json.dumps({"round": round_number, "rounds": options.rounds,
                              "results": [{"scenario": row["scenario"], "status": row["status"]}
                                          for row in report["rows"]
                                          if row["round"] == round_number]},
                             ensure_ascii=False), flush=True)
        report["complete"] = True
    except Exception as exc:
        report["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        try:
            await client.stop()
        except Exception as exc:
            report["cleanup_error"] = f"{type(exc).__name__}: {exc}"
        final_code = code_fingerprints()
        initial_code = report["source_code"]["started"]
        report["source_code"]["finished"] = final_code
        report["source_code"]["files_changed_during_run"] = [
            path for path in sorted(initial_code.keys() | final_code.keys())
            if initial_code.get(path) != final_code.get(path)]
        save()
    print(json.dumps({"output": str(output), "complete": report["complete"],
                      "summary": report["summary"], "error": report.get("error")},
                     ensure_ascii=False), flush=True)
    valid = report["complete"] and not report.get("cleanup_error")
    valid = valid and all(row["status"] != "failed" for row in report["rows"])
    return 0 if valid else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("manager", "http"), default="manager")
    parser.add_argument("--rounds", type=int, default=30)
    parser.add_argument("--duration", type=float, default=120, help="合成片秒数")
    parser.add_argument("--size", default="640x360")
    parser.add_argument("--frame-rate", default="24")
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--media", type=Path, help="manager 模式可选只读本地媒体")
    parser.add_argument("--encoder", default="libx264",
                        help="manager 编码器；HTTP 为用户声明元数据")
    parser.add_argument("--timeout", type=float, default=30)
    parser.add_argument("--poll-ms", type=int, default=50, help="旧后端无 revision 时的轮询间隔")
    parser.add_argument("--cold-target", type=float)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--cookie-env", default="MOONCELL_BENCHMARK_COOKIE")
    parser.add_argument("--media-id", help="HTTP 专用测试媒体，逐轮创建并关闭会话")
    parser.add_argument("--session-id", help="HTTP 已有专用测试会话；不创建、不关闭")
    parser.add_argument("--network-label", default="unspecified; no network shaping applied")
    parser.add_argument("--server-label", default="unspecified")
    options = parser.parse_args()
    if (options.rounds < 1 or not math.isfinite(options.duration) or options.duration < 12
            or not math.isfinite(options.timeout) or options.timeout <= 0 or options.poll_ms < 1):
        parser.error("rounds/poll-ms/timeout 必须为正，duration 至少 12 秒")
    if not 1 <= options.threads <= 16 or not re.fullmatch(r"[1-9]\d*x[1-9]\d*", options.size):
        parser.error("threads 必须为 1..16，size 格式如 640x360")
    if any(value < 2 or value > 8192 or value % 2 for value in map(int, options.size.split("x"))):
        parser.error("合成片宽高必须是 2..8192 之间的偶数")
    try:
        rate = Fraction(options.frame_rate)
        if not 0 < rate <= 240:
            raise ValueError
    except (ValueError, ZeroDivisionError):
        parser.error("frame-rate 必须为 0..240 范围内的正数或分数，如 24000/1001")
    if options.cold_target is not None and (
            not math.isfinite(options.cold_target) or options.cold_target < 0):
        parser.error("cold-target 必须为有限非负秒数")
    if options.mode == "http" and bool(options.media_id) == bool(options.session_id):
        parser.error("HTTP 模式必须且只能指定 media-id 或 session-id")
    if options.mode == "manager" and (options.media_id or options.session_id):
        parser.error("media-id/session-id 仅用于 HTTP 模式")
    parsed_url = urlsplit(options.base_url)
    if (parsed_url.scheme not in {"http", "https"} or not parsed_url.netloc or parsed_url.username
            or parsed_url.password or parsed_url.query or parsed_url.fragment):
        parser.error("base-url 必须是无用户名、密码、query 和 fragment 的 HTTP(S) 地址")
    stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    directory = OUTPUT_ROOT / f"run-{stamp}-{uuid.uuid4().hex[:8]}"
    directory.mkdir(parents=True, exist_ok=False)
    (directory / ".mooncell-seek-benchmark").touch()
    try:
        return asyncio.run(benchmark(options, directory))
    except KeyboardInterrupt:
        print("基准已中断；已有结果保留在 " + str(directory), file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
