"""单 worker、按用户隔离的播放代次与转码生命周期。"""

from __future__ import annotations

import asyncio
import contextlib
import math
import shutil
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

import psutil

from ..config import settings
from . import cache, leases, transcode
from .media import MediaError, ResolvedMedia, ensure_current
from .processes import OwnedProcess
from .schemas import PlaybackInfo


@dataclass
class PlaybackSession:
    id: str
    user_id: int
    media: ResolvedMedia
    info: PlaybackInfo
    directory: Path
    position: float
    quality: int
    audio_track: int | None
    client_id: str | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    generation: int = 1
    status: str = "preparing"
    source_anchor: float = 0
    media_anchor: float = 0
    process_state: str = "preparing"
    error: dict | None = None
    process: OwnedProcess | None = None
    task: asyncio.Task | None = None
    segments: dict[int, cache.Segment] = field(default_factory=dict)
    last_active: float = field(default_factory=time.monotonic)
    last_heartbeat: float = field(default_factory=time.monotonic)
    paused_since: float | None = None
    paused: bool = False
    playback_rate: float = 1
    leased: bool = False
    ended: bool = False
    closed_at: float | None = None
    fallback_used: bool = False
    request_ids: dict[str, int] = field(default_factory=dict)
    retired_segments: list[cache.Segment] = field(default_factory=list)
    retired_directories: list[tuple[Path, float]] = field(default_factory=list)
    process_generation: int = 0
    last_ready_generation: int = 1
    linear_seek: bool = False
    clock_position: float = 0
    clock_started: float = field(default_factory=time.monotonic)
    clock_rate: float = 1
    clock_paused: bool = False
    pending_probes: dict[int, tuple[int, Path, float, asyncio.Task]] = field(default_factory=dict)

    @property
    def generation_directory(self) -> Path:
        return self.directory / f"generation-{self.generation}"


class SessionManager:
    def __init__(self):
        self.sessions: dict[str, PlaybackSession] = {}
        self.requests: dict[tuple[int, str], str] = {}
        self.lock = asyncio.Lock()
        self.monitor: asyncio.Task | None = None
        self.stopping = False
        self.cache_lock: cache.CacheLock | None = None
        self.probe_tasks: set[asyncio.Task] = set()
        self.probe_slots = asyncio.Semaphore(2)

    @property
    def root(self) -> Path:
        return Path(settings.playback_cache_path).resolve()

    async def start(self) -> None:
        if self.monitor and not self.monitor.done():
            return
        self.stopping = False
        self.root.mkdir(parents=True, exist_ok=True)
        if self.cache_lock is None:
            self.cache_lock = cache.CacheLock(self.root)
        # 重启不恢复 PID；仅清理由本服务标记的专有目录。
        for directory in self.root.iterdir():
            if directory.is_dir():
                await asyncio.to_thread(cache.remove_owned, self.root, directory)
        self.monitor = asyncio.create_task(self._monitor(), name="playback-monitor")

    async def shutdown(self) -> None:
        self.stopping = True
        if self.monitor:
            self.monitor.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.monitor
            self.monitor = None
        try:
            async with self.lock:
                for session in self.sessions.values():
                    await self._close(session)
            if self.probe_tasks:
                await asyncio.gather(*list(self.probe_tasks), return_exceptions=True)
        finally:
            if self.cache_lock:
                self.cache_lock.close()
                self.cache_lock = None

    def get(self, user_id: int, session_id: str) -> PlaybackSession:
        session = self.sessions.get(session_id)
        if not session or session.user_id != user_id:
            raise MediaError("session_not_found", "播放会话不存在或已失效", 404)
        return session

    def validate_progress(self, user_id: int, media_id: str, session_id: str,
                          generation: int) -> datetime:
        session = self.get(user_id, session_id)
        if session.media.media_id != media_id or session.generation != generation:
            raise MediaError("stale_generation", "观看记录属于已失效的播放代次", 409)
        if (session.status == "failed" or session.status == "closed"
                and time.monotonic() - (session.closed_at or 0) > 600):
            raise MediaError("session_closed", "播放会话已关闭", 410)
        return session.created_at

    def _check_generation(self, session: PlaybackSession, generation: int) -> None:
        if session.status == "closed":
            raise MediaError("session_closed", "播放会话已关闭", 410)
        if session.generation != generation:
            raise MediaError("stale_generation", "播放代次已更新，请获取最新会话", 409)

    def _position(self, session: PlaybackSession, position: float) -> float:
        if not math.isfinite(position) or position < 0 or position > session.info.duration + 1:
            raise MediaError("invalid_position", "播放位置超出影片范围", 422)
        return min(position, max(0, session.info.duration
                                 - max(0.1, 2 / max(1, session.info.frame_rate))))

    def _has_slot(self, excluding: PlaybackSession | None = None) -> bool:
        active = sum(1 for session in self.sessions.values() if session is not excluding
                     and (session.process and session.process.running
                          or session.status == "preparing"))
        return active < max(1, settings.playback_max_sessions)

    def _check_space(self, session: PlaybackSession | None = None) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        session_bytes = cache.directory_bytes(session.directory) if session else 0
        global_bytes = sum(cache.directory_bytes(item.directory)
                           for item in self.sessions.values())
        if (session_bytes + cache.RESERVE_BYTES > settings.playback_session_quota_mb * 1024**2
                or global_bytes + cache.RESERVE_BYTES
                > settings.playback_global_quota_mb * 1024**2
                or shutil.disk_usage(self.root).free
                < settings.playback_min_free_mb * 1024**2 + cache.RESERVE_BYTES):
            raise MediaError("cache_limit", "播放缓存或磁盘空间不足，请稍后重试", 507)

    async def create(self, user_id: int, media: ResolvedMedia, info: PlaybackInfo,
                     start_time: float, quality: int, audio_track: int | None,
                     request_id: str, client_id: str | None = None) -> dict:
        async with self.lock:
            if self.cache_lock is None:
                raise MediaError("service_unavailable", "播放服务尚未启动", 503)
            previous = self.requests.get((user_id, request_id))
            if previous:
                return self.snapshot(self.get(user_id, previous))
            if self.stopping:
                raise MediaError("service_stopping", "播放服务正在停止", 503)
            if not info.supported:
                raise MediaError("unsupported_media",
                                 info.unsupported_reason or "媒体不受支持", 422)
            if client_id is not None:
                for previous_session in self.sessions.values():
                    if (previous_session.user_id == user_id
                            and previous_session.client_id == client_id
                            and previous_session.status != "closed"):
                        await self._close(previous_session)
            if not self._has_slot():
                raise MediaError("transcode_busy", "服务端转码名额已满，请先关闭其他播放", 429)
            ensure_current(media)
            try:
                self._check_space()
            except MediaError:
                await self._reclaim_closed()
                self._check_space()
            if len(self.sessions) >= 256:
                await self._reclaim_closed()
                if len(self.sessions) >= 256:
                    raise MediaError("session_limit", "暂存播放会话过多，请稍后重试", 429)
            session_id = uuid.uuid4().hex
            session = PlaybackSession(
                session_id, user_id, media, info, self.root / f"session-{session_id}",
                start_time, quality, audio_track, client_id=client_id,
            )
            session.position = self._position(session, start_time)
            session.clock_position = session.position
            transcode.command(media, info, session.generation_directory,
                              session.position, quality, audio_track)
            leases.acquire_source(media.source_id)
            session.leased = True
            try:
                cache.session_directory(self.root, session_id)
            except BaseException:
                leases.release_source(media.source_id)
                raise
            self.sessions[session.id] = session
            self.requests[(user_id, request_id)] = session.id
            if len(self.requests) > 1000:
                self.requests.pop(next(iter(self.requests)))
            session.task = asyncio.create_task(self._prepare(session, session.generation))
            if self.monitor is None or self.monitor.done():
                self.monitor = asyncio.create_task(self._monitor(), name="playback-monitor")
            return self.snapshot(session)

    def snapshot(self, session: PlaybackSession) -> dict:
        values = cache.playable_segments(session.segments)
        return {
            "id": session.id, "media_id": session.media.media_id,
            "generation": session.generation, "status": session.status,
            "duration": session.info.duration, "source_anchor": session.source_anchor,
            "media_anchor": session.media_anchor,
            "playlist_url": f"/api/v1/playback/sessions/{session.id}/"
                            f"{session.generation}/index.m3u8",
            "cached_ranges": [[values[0].source_start,
                               min(session.info.duration,
                                   values[-1].source_start + values[-1].duration)]]
                             if values else [],
            "segments": [{"sequence": segment.sequence, "source_start": segment.source_start,
                          "duration": segment.duration} for segment in values],
            "quality": session.quality, "audio_track": session.audio_track,
            "error": session.error, "process_state": session.process_state,
        }

    async def status(self, user_id: int, session_id: str) -> dict:
        async with self.lock:
            return self.snapshot(self.get(user_id, session_id))

    async def _prepare(self, session: PlaybackSession, generation: int) -> None:
        async with self.lock:
            if generation != session.generation or session.status == "closed":
                return
            try:
                await self._stop_process(session)
                if not self._has_slot(session):
                    raise MediaError("transcode_busy", "服务端转码名额已满", 429)
                ensure_current(session.media)
                if not session.leased:
                    leases.acquire_source(session.media.source_id)
                    session.leased = True
                self._check_space(session)
                session.generation_directory.mkdir(exist_ok=True)
                process = OwnedProcess()
                process.start(transcode.command(
                    session.media, session.info, session.generation_directory, session.position,
                    session.quality, session.audio_track,
                    "libx264" if session.fallback_used else None,
                    force_linear=session.linear_seek,
                ))
                session.process = process
                session.process_generation = generation
                session.process_state = "running"
                # 暂停中 seek 仍要生成首段，供 video 更新静态帧，再挂起生产。
            except MediaError as exc:
                await self._fail(session, exc.code, exc.message)
            except (OSError, ValueError, psutil.Error) as exc:
                await self._fail(session, "encoder_failed",
                                 f"转码进程无法启动：{type(exc).__name__}")

    async def _stop_process(self, session: PlaybackSession) -> None:
        if session.process:
            await session.process.stop()
            session.process = None
        if session.leased:
            leases.release_source(session.media.source_id)
            session.leased = False

    async def _fail(self, session: PlaybackSession, code: str, message: str) -> None:
        self._cancel_probes(session)
        await self._stop_process(session)
        session.status, session.process_state = "failed", "exited"
        session.error = {"code": code, "message": message}

    async def seek(self, user_id: int, session_id: str, generation: int, position: float,
                   request_id: str, quality: int | None = None,
                   audio_track: int | None = None, change_audio: bool = False) -> dict:
        async with self.lock:
            session = self.get(user_id, session_id)
            if request_id in session.request_ids:
                return self.snapshot(session)
            # 同一旧代次的连续拖动在准备期间合并，只有最后一次准备任务能启动。
            if not (session.status == "preparing"
                    and session.last_ready_generation <= generation < session.generation):
                self._check_generation(session, generation)
            next_quality = quality if quality is not None else session.quality
            next_audio = audio_track if change_audio else session.audio_track
            target = self._position(session, position)
            transcode.command(session.media, session.info, session.generation_directory,
                              target, next_quality, next_audio)
            values = cache.playable_segments(session.segments)
            if (session.status in {"ready", "paused"} and values
                    and (session.process and session.process.running or session.ended)
                    and next_quality == session.quality and next_audio == session.audio_track
                    and min(segment.source_start for segment in values) <= target
                    < max(segment.source_start + segment.duration for segment in values)):
                session.position = target
                session.last_active = session.last_heartbeat = time.monotonic()
                session.clock_position, session.clock_started = target, time.monotonic()
                session.request_ids[request_id] = session.generation
                if len(session.request_ids) > 100:
                    session.request_ids.pop(next(iter(session.request_ids)))
                return self.snapshot(session)
            session.position = target
            session.quality, session.audio_track = next_quality, next_audio
            self._restart(session)
            session.request_ids[request_id] = session.generation
            if len(session.request_ids) > 100:
                session.request_ids.pop(next(iter(session.request_ids)))
            return self.snapshot(session)

    def _restart(self, session: PlaybackSession) -> None:
        self._cancel_probes(session)
        session.retired_segments.extend(session.segments.values())
        session.retired_directories.append((session.generation_directory, time.monotonic()))
        session.generation += 1
        session.status, session.process_state = "preparing", "preparing"
        session.source_anchor, session.media_anchor = session.position, 0
        session.segments = {}
        session.error, session.ended = None, False
        session.last_active = time.monotonic()
        session.clock_position, session.clock_started = session.position, time.monotonic()
        session.task = asyncio.create_task(self._prepare(session, session.generation))

    async def heartbeat(self, user_id: int, session_id: str, generation: int,
                        position: float, paused: bool, playback_rate: float) -> dict:
        async with self.lock:
            session = self.get(user_id, session_id)
            self._check_generation(session, generation)
            now = time.monotonic()
            position = self._position(session, position)
            # 心跳不能伪装远距离 seek，突破领先水位继续无限产出。
            expected = session.clock_position + ((now - session.clock_started) * session.clock_rate
                                                 if not session.clock_paused else 0)
            if position > expected + 15 or position < session.position - 15:
                raise MediaError("position_discontinuity", "请通过跳转接口更新播放位置", 409)
            session.clock_position, session.clock_started = expected, now
            session.clock_rate, session.clock_paused = playback_rate, paused
            session.position, session.playback_rate = position, playback_rate
            session.last_active = session.last_heartbeat = now
            session.paused = paused
            if paused:
                session.paused_since = session.paused_since or now
                if session.process and session.process.running and session.segments:
                    session.process.suspend()
                    session.process_state = "user_paused"
                if session.status == "ready":
                    session.status = "paused"
            else:
                session.paused_since = None
                if session.status == "paused" and session.process is None and not session.ended:
                    self._restart(session)
                elif session.status == "paused":
                    session.status = "ready"
                if session.process and session.process.suspended:
                    ahead = self._produced_end(session) - position
                    if ahead < 90:
                        try:
                            self._check_space(session)
                        except MediaError:
                            pass
                        else:
                            session.process.resume()
                            session.process_state = "running"
            return self.snapshot(session)

    async def close(self, user_id: int, session_id: str) -> None:
        async with self.lock:
            session = self.get(user_id, session_id)
            await self._close(session)

    async def _close(self, session: PlaybackSession) -> None:
        if session.status == "closed":
            return
        session.status, session.process_state = "closed", "exited"
        session.closed_at = time.monotonic()
        self._cancel_probes(session)
        await self._stop_process(session)

    async def playlist(self, user_id: int, session_id: str, generation: int) -> str:
        async with self.lock:
            session = self.get(user_id, session_id)
            self._check_generation(session, generation)
            session.last_active = time.monotonic()
            return cache.make_playlist(session.segments, session.ended)

    async def open_segment(self, user_id: int, session_id: str, generation: int,
                           name: str) -> cache.Segment:
        async with self.lock:
            session = self.get(user_id, session_id)
            self._check_generation(session, generation)
            match = cache.SEGMENT_NAME.fullmatch(name)
            segment = session.segments.get(int(match[1])) if match else None
            if segment is None or segment.path.name != name or not segment.path.is_file():
                raise MediaError("segment_not_found", "播放分片已失效，请刷新播放状态", 404)
            segment.readers += 1
            segment.last_access = session.last_active = time.monotonic()
            return segment

    async def release_segment(self, segment: cache.Segment) -> None:
        async with self.lock:
            segment.readers = max(0, segment.readers - 1)
            segment.last_access = time.monotonic()

    def _produced_end(self, session: PlaybackSession) -> float:
        return max((segment.source_start + segment.duration
                    for segment in session.segments.values()), default=session.position)

    async def _refresh(self, session: PlaybackSession) -> None:
        process = session.process
        if (process is None or session.process_generation != session.generation
                or session.status in {"closed", "failed"}):
            return
        # 先检查产出与空间，探测在独立任务中执行，不能阻塞控制和引用释放。
        if process.running:
            try:
                self._check_space(session)
            except MediaError as exc:
                process.suspend()
                session.process_state = "cache_paused"
                session.error = {"code": exc.code, "message": exc.message}
            if process.out_time - session.position >= 90:
                process.suspend()
                session.process_state = "watermark_paused"
        entries, ended = cache.playlist_entries(session.generation_directory / "index.m3u8")
        for sequence, (generation, path, duration, task) in sorted(session.pending_probes.items()):
            if not task.done():
                continue
            if sequence > 0 and sequence - 1 in session.pending_probes:
                continue
            del session.pending_probes[sequence]
            if generation != session.generation:
                continue
            source_start = max(0, task.result() - transcode.TIMESTAMP_OFFSET)
            if (not session.segments and not session.linear_seek
                    and source_start > session.position + max(0.15, 2 / session.info.frame_rate)
                    and sequence == 0):
                session.linear_seek = True
                self._restart(session)
                return
            session.segments[sequence] = cache.Segment(
                sequence, path, source_start, duration, time.monotonic(),
            )
        for sequence, name, duration in entries:
            if sequence in session.segments or sequence in session.pending_probes:
                continue
            if len(session.pending_probes) >= 4:
                break
            path = session.generation_directory / name
            if not path.is_file():
                continue
            task = asyncio.create_task(self._probe_segment(path))
            self.probe_tasks.add(task)
            task.add_done_callback(self._probe_finished)
            session.pending_probes[sequence] = (session.generation, path, duration, task)
        if 0 in session.segments and session.status == "preparing":
            first = min(session.segments.values(), key=lambda segment: segment.sequence)
            session.source_anchor = first.source_start
            session.media_anchor = first.source_start + transcode.TIMESTAMP_OFFSET
            session.status = "paused" if session.paused else "ready"
            session.last_ready_generation = session.generation
        cache.prune(session.segments, session.position)
        unregistered = any(
            sequence not in session.segments and (session.generation_directory / name).is_file()
            for sequence, name, _ in entries
        )
        session.ended = (ended and process.returncode == 0
                         and not session.pending_probes and not unregistered)
        if process.returncode is not None:
            if process.returncode != 0:
                if (settings.playback_encoder != "libx264" and not session.fallback_used
                        and not session.segments):
                    session.fallback_used = True
                    self._restart(session)
                else:
                    await self._fail(session, "encoder_failed", "转码失败，请检查片源或切换清晰度")
            else:
                if session.pending_probes or unregistered:
                    return
                if not session.segments:
                    await self._fail(session, "seek_empty", "目标位置没有可播放的视频帧")
                    return
                await self._stop_process(session)
                session.process_state = "exited"
            return
        if session.paused and session.segments:
            process.suspend()
            session.process_state = "user_paused"
            if session.paused_since and time.monotonic() - session.paused_since >= 60:
                await self._stop_process(session)
                session.process_state = "released"
            return
        try:
            self._check_space(session)
        except MediaError as exc:
            await self._reclaim_closed()
            try:
                self._check_space(session)
            except MediaError:
                pass
            else:
                return
            process.suspend()
            session.process_state, session.error = "cache_paused", {"code": exc.code,
                                                                     "message": exc.message}
            return
        ahead = max(self._produced_end(session), process.out_time) - session.position
        if ahead >= 90:
            process.suspend()
            session.process_state = "watermark_paused"
        elif process.suspended and (ahead <= 30 or session.process_state == "cache_paused"):
            process.resume()
            session.process_state, session.error = "running", None
        if not process.suspended and time.monotonic() - process.last_progress > 45:
            await self._fail(session, "transcode_stalled", "转码长时间没有进展，请重新播放")

    async def _probe_segment(self, path: Path) -> float:
        async with self.probe_slots:
            return await transcode.video_start(path)

    def _probe_finished(self, task: asyncio.Task) -> None:
        self.probe_tasks.discard(task)
        if not task.cancelled():
            task.exception()  # 即使旧代次已放弃，也读取异常避免未处理任务警告。

    def _cancel_probes(self, session: PlaybackSession) -> None:
        for _, _, _, task in session.pending_probes.values():
            task.cancel()
        session.pending_probes.clear()

    async def _cleanup(self, session: PlaybackSession) -> None:
        if any(segment.readers for segment in [*session.segments.values(),
                                              *session.retired_segments]):
            return
        await asyncio.to_thread(cache.remove_owned, self.root, session.directory)
        self.sessions.pop(session.id, None)
        for key, value in list(self.requests.items()):
            if value == session.id:
                del self.requests[key]

    async def _reclaim_closed(self) -> None:
        for session in list(self.sessions.values()):
            if session.status == "closed":
                await self._cleanup(session)

    def _cleanup_retired(self, session: PlaybackSession) -> None:
        for directory, retired_at in list(session.retired_directories):
            related = [segment for segment in session.retired_segments
                       if segment.path.parent == directory]
            if (time.monotonic() - retired_at < 15 or any(segment.readers for segment in related)
                    or session.process and session.process.running
                    and session.process_generation == int(directory.name.partition("-")[2])):
                continue
            if (directory.resolve().parent == session.directory.resolve()
                    and not directory.is_symlink() and not directory.is_junction()
                    and directory.name.startswith("generation-") and directory.exists()):
                shutil.rmtree(directory)
            session.retired_directories.remove((directory, retired_at))
            session.retired_segments = [segment for segment in session.retired_segments
                                        if segment.path.parent != directory]

    async def _monitor(self) -> None:
        while True:
            await asyncio.sleep(0.25)
            async with self.lock:
                now = time.monotonic()
                for session in list(self.sessions.values()):
                    try:
                        if session.status != "closed" and now - session.last_active > 120:
                            await self._close(session)
                        if session.status == "closed":
                            if now - (session.closed_at or now) > 600:
                                await self._cleanup(session)
                            continue
                        self._cleanup_retired(session)
                        await self._refresh(session)
                    except MediaError as exc:
                        await self._fail(session, exc.code, exc.message)
                    except (OSError, psutil.Error):
                        await self._fail(session, "process_error", "播放进程或缓存暂时不可用")

manager = SessionManager()
