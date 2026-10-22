"""有界、可取消的 FFprobe 与字幕转换，按不可变媒体版本复用探测。"""

import asyncio
import contextlib
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from collections import OrderedDict
from pathlib import Path

import psutil

from ..config import settings
from .media import MediaError, ResolvedMedia, ensure_current, safe_file
from .processes import WindowsJob
from .schemas import AudioTrack, PlaybackCapabilities, PlaybackInfo, SubtitleTrack

_slots = asyncio.Semaphore(2)
_cache: OrderedDict[str, PlaybackInfo] = OrderedDict()
_inflight: dict[str, asyncio.Task] = {}
_capability_cache: tuple[float, PlaybackCapabilities] | None = None
SUPPORTED_SUBTITLES = {"subrip", "srt", "webvtt", "vtt"}
SUBTITLE_EXTENSIONS = {".srt", ".vtt", ".ass", ".ssa", ".sup", ".sub", ".idx"}


def _remember(media_id: str, info: PlaybackInfo) -> None:
    _cache[media_id] = info
    _cache.move_to_end(media_id)
    while len(_cache) > 256:
        _cache.popitem(last=False)


def _settle_probe(media_id: str, task: asyncio.Task) -> None:
    if _inflight.get(media_id) is task:
        _inflight.pop(media_id, None)
    # 即使唯一的请求已取消，也收取结果/异常，避免遗留 Task 或未读取异常。
    if not task.cancelled() and task.exception() is None:
        _remember(media_id, task.result())


async def shutdown_probes() -> None:
    tasks = list(_inflight.values())
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    _inflight.clear()


def _run_media_command_sync(
    arguments: list[str], timeout: float, max_bytes: int, cancelled: threading.Event,
) -> bytes:
    """独立线程持有进程及管道，兼容 Windows Uvicorn 的 Selector 事件循环。"""
    process = None
    job = None
    readers = []
    chunks: list[bytes] = []
    overflow = threading.Event()
    deadline = time.monotonic() + timeout

    def drain(stream, collect: bool) -> None:
        total = 0
        try:
            while chunk := stream.read(65536):
                total += len(chunk)
                if total > max_bytes:
                    overflow.set()
                elif collect:
                    chunks.append(chunk)
        except (OSError, ValueError):
            pass

    try:
        flags = 0
        if os.name == "nt":
            job = WindowsJob()
            flags = 0x00000004 | subprocess.CREATE_NO_WINDOW
        elif sys.platform.startswith("linux"):
            arguments = [sys.executable, "-m", "app.playback.processes", str(os.getpid()),
                         "--", *arguments]
        process = subprocess.Popen(
            arguments, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            creationflags=flags, close_fds=True,
        )
        if job:
            job.assign(process)
            psutil.Process(process.pid).resume()
        readers = [threading.Thread(target=drain, args=(process.stdout, True), daemon=True),
                   threading.Thread(target=drain, args=(process.stderr, False), daemon=True)]
        for reader in readers:
            reader.start()
        while process.poll() is None:
            if cancelled.is_set():
                raise MediaError("probe_cancelled", "媒体工具任务已取消", 409)
            if overflow.is_set():
                raise MediaError("probe_output_limit", "媒体工具输出超出限制", 422)
            if time.monotonic() >= deadline:
                raise MediaError("probe_timeout", "媒体探测超时，请稍后重试", 504)
            with contextlib.suppress(subprocess.TimeoutExpired):
                process.wait(timeout=min(0.05, max(0.001, deadline - time.monotonic())))
        for reader in readers:
            reader.join(timeout=1)
        if overflow.is_set():
            raise MediaError("probe_output_limit", "媒体工具输出超出限制", 422)
        if process.returncode != 0:
            raise MediaError("probe_failed", "媒体文件无法解析或字幕提取失败", 422)
        return b"".join(chunks)
    except (OSError, ValueError, psutil.Error) as exc:
        raise MediaError(
            "tool_unavailable", "FFmpeg/FFprobe 不可用，请检查服务端配置", 503,
        ) from exc
    finally:
        if process is not None and process.poll() is None:
            with contextlib.suppress(OSError):
                process.kill()
        if job:
            job.close()
        if process is not None:
            with contextlib.suppress(OSError, subprocess.TimeoutExpired):
                process.wait(timeout=5)
            for reader in readers:
                reader.join(timeout=1)
            for stream in (process.stdout, process.stderr):
                if stream:
                    stream.close()
            if os.name == "nt" and process.returncode is not None:
                # Task 异常回溯可能继续持有 Popen，显式释放已收割进程的 Windows 句柄。
                process._handle.Close()


async def run_media_command(
    arguments: list[str], timeout: float, max_bytes: int = 8 * 1024 * 1024,
) -> bytes:
    """持续排空有界管道，取消时等待线程终止并收割本次任务的进程。"""
    cancelled = threading.Event()
    task = asyncio.create_task(asyncio.to_thread(
        _run_media_command_sync, arguments, timeout, max_bytes, cancelled,
    ))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        cancelled.set()
        with contextlib.suppress(MediaError):
            await asyncio.shield(task)
        raise


def _number(value, fallback=0.0) -> float:
    try:
        result = float(value)
        return result if math.isfinite(result) else fallback
    except (TypeError, ValueError):
        return fallback


def _rate(value: str | None) -> float:
    try:
        first, second = (value or "24/1").split("/")
        return min(240, max(1, float(first) / float(second)))
    except (ValueError, ZeroDivisionError):
        return 24


def parse_probe(media: ResolvedMedia, data: dict) -> PlaybackInfo:
    streams = data.get("streams", [])
    videos = [stream for stream in streams if stream.get("codec_type") == "video"
              and not stream.get("disposition", {}).get("attached_pic")]
    if not videos:
        raise MediaError("video_missing", "文件没有可播放的视频轨道", 422)
    video = videos[0]
    duration = _number(data.get("format", {}).get("duration")) or _number(video.get("duration"))
    if duration <= 0:
        raise MediaError("duration_unknown", "无法确定视频时长，暂不能播放此文件", 422)
    hdr = (video.get("color_transfer") in {"smpte2084", "arib-std-b67"}
           or any("mastering display" in item.get("side_data_type", "").lower()
                  or "content light" in item.get("side_data_type", "").lower()
                  or "dovi" in item.get("side_data_type", "").lower()
                  for item in video.get("side_data_list", [])))
    width, height = int(video.get("width", 0)), int(video.get("height", 0))
    if width < 2 or height < 2:
        raise MediaError("video_dimensions", "视频尺寸无效", 422)
    audio, subtitles = [], []
    for stream in streams:
        tags = stream.get("tags", {})
        codec = stream.get("codec_name", "unknown")
        if stream.get("codec_type") == "audio":
            audio.append(AudioTrack(
                id=stream["index"], codec=codec, language=tags.get("language"),
                title=tags.get("title"), channels=stream.get("channels"),
                default=bool(stream.get("disposition", {}).get("default")),
            ))
        elif stream.get("codec_type") == "subtitle":
            supported = codec in SUPPORTED_SUBTITLES
            subtitles.append(SubtitleTrack(
                id=f"s:{stream['index']}", codec=codec, language=tags.get("language"),
                title=tags.get("title") or f"内嵌字幕 {len(subtitles) + 1}", supported=supported,
                reason=None if supported else "首版暂不支持此字幕格式，请选择 SRT/WebVTT 字幕",
            ))
    return PlaybackInfo(
        media_id=media.media_id, source_id=media.source_id, filename=media.path.name,
        version=media.version, duration=duration, video_width=width, video_height=height,
        video_codec=video.get("codec_name", "unknown"), video_track=int(video.get("index", 0)),
        frame_rate=_rate(
            video.get("avg_frame_rate") or video.get("r_frame_rate"),
        ), hdr=hdr, supported=not hdr,
        unsupported_reason="HDR 视频需要色调映射，首版暂不支持播放" if hdr else None,
        qualities=[720, 1080] if height > 720 else [720],
        audio_tracks=audio, subtitle_tracks=subtitles,
    )


def _external_subtitles(media: ResolvedMedia) -> list[tuple[SubtitleTrack, Path]]:
    results = []
    try:
        candidates = sorted(media.path.parent.iterdir(), key=lambda p: p.name.casefold())
    except OSError:
        return results
    for candidate in candidates:
        if candidate.suffix.lower() not in SUBTITLE_EXTENSIONS:
            continue
        if not (candidate.stem == media.path.stem
                or candidate.stem.startswith(media.path.stem + ".")):
            continue
        relative = candidate.relative_to(media.directory).as_posix()
        try:
            path = safe_file(media.library_root, media.directory, relative)
        except MediaError:
            continue
        codec = candidate.suffix[1:].lower()
        supported = codec in SUPPORTED_SUBTITLES
        track_id = "e:" + hashlib.sha256(relative.encode()).hexdigest()[:24]
        results.append((SubtitleTrack(
            id=track_id, codec=codec, title=candidate.name, supported=supported,
            reason=None if supported else "首版暂不支持此字幕格式，请选择 SRT/WebVTT 字幕",
        ), path))
    return results


def _read_external(path: Path) -> bytes:
    try:
        with path.open("rb") as source:
            raw = source.read(5 * 1024 * 1024 + 1)
    except OSError as exc:
        raise MediaError("subtitle_unreadable", "字幕文件暂时不可读取", 404) from exc
    if len(raw) > 5 * 1024 * 1024:
        raise MediaError("subtitle_too_large", "字幕文件过大", 422)
    return raw


async def _load_probe(media: ResolvedMedia) -> PlaybackInfo:
    async with _slots:
        await asyncio.to_thread(ensure_current, media)
        output = await run_media_command([
            settings.playback_ffprobe, "-v", "error", "-protocol_whitelist", "file,pipe",
            "-format_whitelist", "mov,matroska,webm,avi,mpegts,mpeg,flv,asf,ogg",
            "-show_streams", "-show_format", "-of", "json", str(media.path),
        ], settings.playback_probe_timeout_seconds)
        await asyncio.to_thread(ensure_current, media)
        try:
            return parse_probe(media, json.loads(output))
        except (ValueError, KeyError, TypeError) as exc:
            raise MediaError("probe_failed", "媒体探测结果无效", 422) from exc


async def probe_media(media: ResolvedMedia) -> PlaybackInfo:
    await asyncio.to_thread(ensure_current, media)
    cached = _cache.get(media.media_id)
    if cached is None and media.probe_json:
        try:
            cached = PlaybackInfo.model_validate_json(media.probe_json)
        except ValueError:
            pass
    if cached is None:
        task = _inflight.get(media.media_id)
        if task is None:
            if len(_inflight) >= 32:
                raise MediaError("probe_busy", "等待探测的媒体过多，请稍后重试", 503)
            task = asyncio.create_task(_load_probe(media))
            _inflight[media.media_id] = task
            task.add_done_callback(lambda finished: _settle_probe(media.media_id, finished))
        try:
            # 多个请求复用一个探测，单个客户端取消不会取消其他请求的工作。
            cached = await asyncio.shield(task)
        finally:
            if task.done():
                _inflight.pop(media.media_id, None)
        _remember(media.media_id, cached)
    result = cached.model_copy(deep=True)
    result.subtitle_tracks.extend(track for track, _path in await asyncio.to_thread(
        _external_subtitles, media,
    ))
    for track in result.subtitle_tracks:
        if track.supported:
            track.url = f"/api/v1/media/{media.media_id}/subtitles/{track.id}"
    return result


async def subtitle_content(media: ResolvedMedia, track_id: str) -> str:
    info = await probe_media(media)
    track = next((item for item in info.subtitle_tracks if item.id == track_id), None)
    if track is None:
        raise MediaError("subtitle_not_found", "字幕不存在", 404)
    if not track.supported:
        raise MediaError("subtitle_unsupported", track.reason or "暂不支持此字幕格式", 422)
    await asyncio.to_thread(ensure_current, media)
    if track_id.startswith("e:"):
        candidates = await asyncio.to_thread(_external_subtitles, media)
        path = next((path for item, path in candidates if item.id == track_id), None)
        if path is None:
            raise MediaError("subtitle_not_found", "字幕文件已移动", 404)
        raw = await asyncio.to_thread(_read_external, path)
        try:
            content = raw.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise MediaError("subtitle_encoding", "字幕需要使用 UTF-8 编码", 422) from exc
        if track.codec == "srt":
            content = "WEBVTT\n\n" + re.sub(r"(\d{2}:\d{2}:\d{2}),(\d{3})", r"\1.\2", content)
        elif not content.lstrip().startswith("WEBVTT"):
            raise MediaError("subtitle_invalid", "WebVTT 字幕格式无效", 422)
        return content
    async with _slots:
        output = await run_media_command([
            settings.playback_ffmpeg, "-v", "error", "-nostdin", "-protocol_whitelist",
            "file,pipe", "-format_whitelist", "mov,matroska,webm,avi,mpegts,mpeg,flv,asf,ogg",
            "-i", str(media.path), "-map", f"0:{track.id[2:]}", "-f", "webvtt", "pipe:1",
        ], settings.playback_probe_timeout_seconds, 5 * 1024 * 1024)
        return output.decode("utf-8-sig")


async def playback_capabilities() -> PlaybackCapabilities:
    global _capability_cache
    if _capability_cache and time.monotonic() - _capability_cache[0] < 60:
        return _capability_cache[1]
    ffmpeg = shutil.which(settings.playback_ffmpeg) is not None
    ffprobe = shutil.which(settings.playback_ffprobe) is not None
    result = PlaybackCapabilities(available=False, ffmpeg=ffmpeg, ffprobe=ffprobe,
                                  encoder=settings.playback_encoder)
    if not ffmpeg or not ffprobe:
        result.reason = "服务器尚未安装 FFmpeg/FFprobe，或可执行文件路径无效"
    else:
        try:
            async with _slots:
                await run_media_command([
                    settings.playback_ffmpeg, "-v", "error", "-nostdin", "-f", "lavfi",
                    "-i", "color=size=128x72:rate=24", "-frames:v", "2", "-an", "-c:v",
                    settings.playback_encoder, "-pix_fmt", "yuv420p", "-f", "null", "-",
                ], min(settings.playback_probe_timeout_seconds, 10))
            result.available = True
            if settings.playback_encoder != "libx264":
                result.hardware_encoders = [settings.playback_encoder]
        except MediaError:
            result.reason = f"编码器 {settings.playback_encoder} 实际编码自检失败"
    _capability_cache = time.monotonic(), result
    return result
