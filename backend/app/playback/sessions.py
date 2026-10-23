"""单 worker、按用户隔离的播放代次与转码生命周期。"""

from __future__ import annotations

import asyncio
import contextlib
import math
import shutil
import subprocess
import time
import uuid
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from pathlib import Path

import psutil

from ..config import settings
from . import cache, leases, transcode
from .media import MediaError, ResolvedMedia, ensure_current
from .planner import PlaybackPlan, plan_playback
from .processes import OwnedProcess
from .schemas import ClientPlaybackCapabilities, PlaybackInfo


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
    process_mode: str = "transcode"
    last_ready_generation: int = 1
    seek_preroll: float = 0
    clock_position: float = 0
    clock_started: float = field(default_factory=time.monotonic)
    clock_rate: float = 1
    clock_paused: bool = False
    pending_probes: dict[int, tuple[int, Path, float, asyncio.Task]] = field(default_factory=dict)
    revision: int = 1
    seek_revision: int = 0
    changed: asyncio.Event = field(default_factory=asyncio.Event)
    process_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    stop_task: asyncio.Task | None = None
    stopping_generations: set[int] = field(default_factory=set)
    stopping_modes: dict[int, str] = field(default_factory=dict)
    prepare_started: float = field(default_factory=time.perf_counter)
    timings: dict[str, float | None] = field(default_factory=lambda: {
        "stop_ms": None, "spawn_ms": None, "first_segment_ms": None, "ready_ms": None,
    })
    seek_disposition: str | None = None
    needs_recovery: bool = False
    plan: PlaybackPlan | None = None
    capabilities: ClientPlaybackCapabilities | None = None
    force_transcode: bool = False
    max_bitrate: int | None = None
    produced_ranges: list[tuple[float, float]] = field(default_factory=list)

    @property
    def generation_directory(self) -> Path:
        return self.directory / f"generation-{self.generation}"

    @property
    def mode(self) -> str:
        return self.plan.mode if self.plan else "transcode"


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
        self.lifecycle_tasks: set[asyncio.Task] = set()
        self.refresh_requested = asyncio.Event()

    def _notify(self, session: PlaybackSession) -> None:
        session.revision += 1
        previous, session.changed = session.changed, asyncio.Event()
        previous.set()

    def _task(self, coroutine) -> asyncio.Task:
        task = asyncio.create_task(coroutine)
        self.lifecycle_tasks.add(task)
        task.add_done_callback(self._lifecycle_finished)
        return task

    def _lifecycle_finished(self, task: asyncio.Task) -> None:
        self.lifecycle_tasks.discard(task)
        if not task.cancelled():
            task.exception()

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
            while self.lifecycle_tasks:
                await asyncio.gather(*list(self.lifecycle_tasks), return_exceptions=True)
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
                          generation: int, seek_revision: int | None = None) -> datetime:
        session = self.get(user_id, session_id)
        if session.media.media_id != media_id or session.generation != generation:
            raise MediaError("stale_generation", "观看记录属于已失效的播放代次", 409)
        if seek_revision is not None and seek_revision != session.seek_revision:
            raise MediaError("stale_seek_revision", "观看记录属于已失效的跳转位置", 409)
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

    def _has_slot(self, excluding: PlaybackSession | None = None,
                  mode: str = "transcode") -> bool:
        if mode == "direct":
            return True
        active = sum(1 for session in self.sessions.values() if session is not excluding
                     and (mode in session.stopping_modes.values()
                          or session.process and session.process.running
                          and session.process_mode == mode
                          or session.status == "preparing" and session.mode == mode))
        limit = (settings.playback_max_remux_sessions if mode == "remux"
                 else settings.playback_max_sessions)
        return active < max(1, limit)

    def _check_space(self, session: PlaybackSession | None = None) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        reserve_bytes = cache.RESERVE_BYTES
        if session is not None and session.mode == "remux":
            average_bitrate = (session.info.bit_rate
                               or session.media.size * 8 / max(0.001, session.info.duration))
            # 原码流不受转码的 6 Mbps 上限约束。为六秒片及监控间隔额外产出预留空间，
            # 平均码率再乘二覆盖常见峰值；运行中的目录配额/磁盘余量检查仍不可省略。
            reserve_bytes = max(reserve_bytes, math.ceil(average_bitrate / 8 * (6 + 2) * 2))
        session_bytes = cache.directory_bytes(session.directory) if session else 0
        global_bytes = sum(cache.directory_bytes(item.directory)
                           for item in self.sessions.values())
        if (session_bytes + reserve_bytes > settings.playback_session_quota_mb * 1024**2
                or global_bytes + reserve_bytes
                > settings.playback_global_quota_mb * 1024**2
                or shutil.disk_usage(self.root).free
                < settings.playback_min_free_mb * 1024**2 + reserve_bytes):
            raise MediaError("cache_limit", "播放缓存或磁盘空间不足，请稍后重试", 507)

    async def create(self, user_id: int, media: ResolvedMedia, info: PlaybackInfo,
                     start_time: float, quality: int, audio_track: int | None,
                     request_id: str, client_id: str | None = None,
                     capabilities: ClientPlaybackCapabilities | None = None,
                     force_transcode: bool = False, max_bitrate: int | None = None) -> dict:
        plan = plan_playback(info, quality, audio_track, capabilities,
                             force_transcode=force_transcode, max_bitrate=max_bitrate)
        # 同一标签页刷新先标记旧会话关闭；等进程回收时不持有全局控制锁。
        closing = []
        async with self.lock:
            previous = self.requests.get((user_id, request_id))
            if previous:
                return self.snapshot(self.get(user_id, previous))
            if client_id is not None:
                for previous_session in self.sessions.values():
                    if (previous_session.user_id == user_id
                            and previous_session.client_id == client_id
                            and previous_session.status != "closed"):
                        await self._close(previous_session)
                        if previous_session.stop_task:
                            closing.append(previous_session.stop_task)
        if closing:
            await asyncio.shield(asyncio.gather(*closing))
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
            if not self._has_slot(mode=plan.mode):
                raise MediaError("transcode_busy", "服务端转码名额已满，请先关闭其他播放", 429)
            ensure_current(media)
            if plan.mode != "direct":
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
                plan=plan, capabilities=capabilities,
                force_transcode=force_transcode, max_bitrate=max_bitrate,
            )
            session.position = self._position(session, start_time)
            session.clock_position = session.position
            if plan.mode != "direct":
                transcode.command(media, info, session.generation_directory,
                                  session.position, plan.output_quality, audio_track, plan=plan)
            leases.acquire_source(media.source_id)
            session.leased = True
            try:
                if plan.mode != "direct":
                    cache.session_directory(self.root, session_id)
            except BaseException:
                leases.release_source(media.source_id)
                raise
            self.sessions[session.id] = session
            self.requests[(user_id, request_id)] = session.id
            if len(self.requests) > 1000:
                self.requests.pop(next(iter(self.requests)))
            if plan.mode == "direct":
                session.status, session.process_state = "ready", "not-needed"
                session.source_anchor, session.media_anchor = 0, 0
                session.timings["ready_ms"] = (
                    time.perf_counter() - session.prepare_started
                ) * 1000
            else:
                session.task = self._task(self._prepare(session, session.generation))
            if self.monitor is None or self.monitor.done():
                self.monitor = asyncio.create_task(self._monitor(), name="playback-monitor")
            return self.snapshot(session)

    def snapshot(self, session: PlaybackSession) -> dict:
        values = cache.playable_segments(session.segments)
        prefix = f"/api/v1/playback/sessions/{session.id}/{session.generation}"
        output_height = session.info.video_height
        output_width = session.info.video_width
        if session.mode == "transcode":
            requested = session.plan.output_quality if session.plan else session.quality
            output_height = max(2, min(output_height, requested) // 2 * 2)
            output_width = max(2, min(round(output_height * session.info.video_width
                                            / session.info.video_height), output_width) // 2 * 2)
        return {
            "id": session.id, "media_id": session.media.media_id,
            "generation": session.generation, "status": session.status,
            "revision": session.revision, "seek_revision": session.seek_revision,
            "position": session.position,
            "seek_disposition": session.seek_disposition,
            "requires_reload": session.seek_disposition == "restart",
            "needs_recovery": session.needs_recovery,
            "timings": dict(session.timings),
            "playback_mode": session.mode,
            "output_height": output_height, "output_width": output_width,
            "mode_reason": session.plan.reason if session.plan else "按客户端能力转码",
            "mime_type": (session.plan.mime_type if session.plan
                          else "application/vnd.apple.mpegurl"),
            "timeline_mode": "source" if session.mode == "direct" else "anchored",
            "stream_url": f"{prefix}/stream" if session.mode == "direct"
                          else f"{prefix}/index.m3u8",
            "duration": session.info.duration, "source_anchor": session.source_anchor,
            "media_anchor": session.media_anchor,
            "playlist_url": f"{prefix}/index.m3u8",
            "cached_ranges": [[values[0].source_start,
                               min(session.info.duration,
                                   values[-1].source_start + values[-1].duration)]]
                             if values else [],
            "segments": [{"sequence": segment.sequence, "source_start": segment.source_start,
                          "duration": segment.duration} for segment in values],
            "quality": session.quality, "audio_track": session.audio_track,
            "error": session.error, "process_state": session.process_state,
        }

    async def status(self, user_id: int, session_id: str,
                     after_revision: int | None = None, wait_ms: int = 0) -> dict:
        async with self.lock:
            session = self.get(user_id, session_id)
            if after_revision is None or session.revision != after_revision or wait_ms <= 0:
                return self.snapshot(session)
            changed = session.changed
        # Event 在锁内取得，通知时替换，避免检查 revision 与开始等待之间丢失唤醒。
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(changed.wait(), min(1500, max(0, wait_ms)) / 1000)
        async with self.lock:
            return self.snapshot(self.get(user_id, session_id))

    async def _prepare(self, session: PlaybackSession, generation: int) -> None:
        # 一个会话只允许一组停止/启动操作；慢进程不能占住其他会话的控制锁。
        async with session.process_lock:
            try:
                async with self.lock:
                    if generation != session.generation or session.status != "preparing":
                        return
                    previous, session.process = session.process, None
                    previous_generation = session.process_generation
                    if previous:
                        session.stopping_generations.add(previous_generation)
                        session.stopping_modes[previous_generation] = session.process_mode
                if previous:
                    started = time.perf_counter()
                    try:
                        await previous.stop(fast=True)
                    except (OSError, subprocess.SubprocessError, psutil.Error):
                        async with self.lock:
                            if previous.running:
                                # 超时不能把仍活着的进程变成无主资源，下一次回收仍可找到它。
                                session.process = previous
                                session.process_generation = previous_generation
                        raise
                    finally:
                        async with self.lock:
                            if not previous.running:
                                session.stopping_generations.discard(previous_generation)
                                session.stopping_modes.pop(previous_generation, None)
                            if generation == session.generation:
                                session.timings["stop_ms"] = (time.perf_counter() - started) * 1000
                async with self.lock:
                    if generation != session.generation or session.status != "preparing":
                        return
                    if not self._has_slot(session, session.mode):
                        raise MediaError("transcode_busy", "服务端转码名额已满", 429)
                    ensure_current(session.media)
                    if not session.leased:
                        leases.acquire_source(session.media.source_id)
                        session.leased = True
                    if session.mode == "direct":
                        session.status = "paused" if session.paused else "ready"
                        session.process_state = "not-needed"
                        session.source_anchor, session.media_anchor = 0, 0
                        session.last_ready_generation = generation
                        session.timings["ready_ms"] = (
                            time.perf_counter() - session.prepare_started
                        ) * 1000
                        self._notify(session)
                        return
                    self._check_space(session)
                    cache.session_directory(self.root, session.id)
                    directory = session.generation_directory
                    directory.mkdir(exist_ok=True)
                    arguments = transcode.command(
                        session.media, session.info, directory, session.position,
                        session.plan.output_quality if session.plan else session.quality,
                        session.audio_track,
                        "libx264" if session.fallback_used else None,
                        seek_preroll=session.seek_preroll,
                        plan=session.plan,
                    )
                process = OwnedProcess()
                started = time.perf_counter()
                await asyncio.to_thread(process.start, arguments)
                async with self.lock:
                    current = generation == session.generation and session.status == "preparing"
                    if current:
                        session.timings["spawn_ms"] = (time.perf_counter() - started) * 1000
                        session.process = process
                        session.process_generation = generation
                        session.process_mode = session.mode
                        session.process_state = "running"
                        self._notify(session)
                if not current:
                    # 启动期间到来的 seek/close 已取代本次尝试；新进程从未向客户端发布。
                    await process.stop(fast=True)
                self.refresh_requested.set()
            except MediaError as exc:
                async with self.lock:
                    if generation == session.generation and session.status == "preparing":
                        await self._fail(session, exc.code, exc.message)
            except (OSError, ValueError, subprocess.SubprocessError, psutil.Error) as exc:
                async with self.lock:
                    if generation == session.generation and session.status == "preparing":
                        await self._fail(session, "encoder_failed",
                                         f"转码进程无法启动：{type(exc).__name__}")

    async def _stop_process(self, session: PlaybackSession) -> None:
        """供维护/测试显式等待；生产控制通过 _queue_stop 在全局锁外回收。"""
        async with session.process_lock:
            if session.process:
                process, session.process = session.process, None
                try:
                    await process.stop()
                except BaseException:
                    if process.running:
                        session.process = process
                    raise
            if session.leased:
                leases.release_source(session.media.source_id)
                session.leased = False

    def _queue_stop(self, session: PlaybackSession, reason: str) -> None:
        session.stop_task = self._task(self._dispose(session, session.generation, reason))

    async def _dispose(self, session: PlaybackSession, generation: int, reason: str) -> None:
        async with session.process_lock:
            async with self.lock:
                if generation != session.generation:
                    return
                if ((reason == "pause" and not session.paused)
                        or (reason == "complete" and not session.ended)
                        or (reason == "failed" and session.status != "failed")
                        or (reason == "closed" and session.status != "closed")):
                    return
                process, session.process = session.process, None
                if process:
                    session.stopping_generations.add(session.process_generation)
                    session.stopping_modes[session.process_generation] = session.process_mode
                process_generation = session.process_generation
            try:
                if process:
                    await process.stop(fast=reason == "closed")
            except (OSError, subprocess.SubprocessError, psutil.Error):
                async with self.lock:
                    if generation == session.generation:
                        session.status, session.process_state = "failed", "stop-failed"
                        session.error = {"code": "process_stop_failed",
                                         "message": "旧转码进程尚未退出，请稍后重试"}
            finally:
                async with self.lock:
                    alive = process is not None and process.running
                    if alive:
                        session.process = process
                        session.process_generation = process_generation
                    else:
                        session.stopping_generations.discard(process_generation)
                        session.stopping_modes.pop(process_generation, None)
                    if generation == session.generation:
                        if session.leased and not alive:
                            leases.release_source(session.media.source_id)
                            session.leased = False
                        self._notify(session)

    async def _fail(self, session: PlaybackSession, code: str, message: str) -> None:
        self._cancel_probes(session)
        session.status, session.process_state = "failed", "exited"
        session.error = {"code": code, "message": message}
        self._queue_stop(session, "failed")
        self._notify(session)

    async def seek(self, user_id: int, session_id: str, generation: int, position: float,
                   request_id: str, quality: int | None = None,
                   audio_track: int | None = None, change_audio: bool = False,
                   client_buffered: bool = False,
                   capabilities: ClientPlaybackCapabilities | None = None,
                   force_transcode: bool | None = None, max_bitrate: int | None = None,
                   change_max_bitrate: bool = False) -> dict:
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
            next_caps = capabilities if capabilities is not None else session.capabilities
            next_force = session.force_transcode if force_transcode is None else force_transcode
            next_max = max_bitrate if change_max_bitrate else session.max_bitrate
            next_plan = plan_playback(session.info, next_quality, next_audio, next_caps,
                                      force_transcode=next_force, max_bitrate=next_max)
            if next_plan.mode != "direct":
                transcode.command(session.media, session.info, session.generation_directory,
                                  target, next_plan.output_quality, next_audio, plan=next_plan)
            values = cache.playable_segments(session.segments)
            cached = (values
                    and (session.process and session.process.running or session.ended)
                    and min(segment.source_start for segment in values) <= target
                    < max(segment.source_start + segment.duration for segment in values))
            session.seek_revision += 1
            same_output = (next_quality == session.quality and next_audio == session.audio_track
                           and next_plan == session.plan)
            direct = session.mode == next_plan.mode == "direct"
            buffered = client_buffered and any(start <= target < end
                                               for start, end in session.produced_ranges)
            if (session.status in {"ready", "paused"}
                    and (direct or same_output and (buffered or cached))):
                session.position = target
                session.quality, session.audio_track = next_quality, next_audio
                session.plan, session.capabilities = next_plan, next_caps
                session.force_transcode, session.max_bitrate = next_force, next_max
                session.last_active = session.last_heartbeat = time.monotonic()
                session.clock_position, session.clock_started = target, time.monotonic()
                session.seek_disposition = "buffered" if buffered else "server-cache"
                session.needs_recovery = not direct and not bool(cached)
                session.request_ids[request_id] = session.generation
                if len(session.request_ids) > 100:
                    session.request_ids.pop(next(iter(session.request_ids)))
                self._notify(session)
                return self.snapshot(session)
            session.position = target
            session.quality, session.audio_track = next_quality, next_audio
            session.plan, session.capabilities = next_plan, next_caps
            session.force_transcode, session.max_bitrate = next_force, next_max
            session.seek_preroll = 0
            session.seek_disposition, session.needs_recovery = "restart", False
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
        session.seek_disposition, session.needs_recovery = "restart", False
        session.source_anchor, session.media_anchor = session.position, 0
        session.segments = {}
        session.produced_ranges = []
        session.error, session.ended = None, False
        session.last_active = time.monotonic()
        session.clock_position, session.clock_started = session.position, time.monotonic()
        session.prepare_started = time.perf_counter()
        session.timings = dict.fromkeys(session.timings)
        session.task = self._task(self._prepare(session, session.generation))
        self._notify(session)

    async def heartbeat(self, user_id: int, session_id: str, generation: int,
                        position: float, paused: bool, playback_rate: float,
                        seek_revision: int | None = None) -> dict:
        async with self.lock:
            session = self.get(user_id, session_id)
            previous_status = session.status, session.process_state, session.paused
            self._check_generation(session, generation)
            if seek_revision is not None and seek_revision != session.seek_revision:
                raise MediaError("stale_seek_revision", "心跳属于已失效的跳转位置", 409)
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
                if (session.process and session.process.running
                        and self._target_available(session)):
                    session.process.suspend()
                    session.process_state = "user_paused"
                if session.status == "ready":
                    session.status = "paused"
            else:
                session.paused_since = None
                if session.mode == "direct":
                    if not session.leased:
                        ensure_current(session.media)
                        leases.acquire_source(session.media.source_id)
                        session.leased = True
                    session.status, session.process_state = "ready", "not-needed"
                elif session.status == "paused" and session.process is None and not session.ended:
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
            if previous_status != (session.status, session.process_state, session.paused):
                self._notify(session)
            return self.snapshot(session)

    async def close(self, user_id: int, session_id: str) -> None:
        async with self.lock:
            session = self.get(user_id, session_id)
            await self._close(session)
            stopping = session.stop_task
        if stopping:
            await asyncio.shield(stopping)

    async def _close(self, session: PlaybackSession) -> None:
        if session.status == "closed":
            return
        session.status, session.process_state = "closed", "exited"
        session.closed_at = time.monotonic()
        self._cancel_probes(session)
        self._queue_stop(session, "closed")
        self._notify(session)

    async def playlist(self, user_id: int, session_id: str, generation: int) -> str:
        async with self.lock:
            session = self.get(user_id, session_id)
            self._check_generation(session, generation)
            session.last_active = time.monotonic()
            return cache.make_playlist(session.segments, session.ended,
                                       target_duration=6 if session.mode == "remux" else None,
                                       independent=session.mode != "remux")

    async def open_direct(self, user_id: int, session_id: str,
                          generation: int) -> ResolvedMedia:
        async with self.lock:
            session = self.get(user_id, session_id)
            self._check_generation(session, generation)
            if session.mode != "direct" or session.status not in {"ready", "paused"}:
                raise MediaError("direct_unavailable", "当前会话不能直接读取原文件", 409)
            ensure_current(session.media)
            if not session.leased:
                leases.acquire_source(session.media.source_id)
                session.leased = True
            leases.retain_source(session.media.source_id)
            session.last_active = time.monotonic()
            return session.media

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

    def _target_available(self, session: PlaybackSession) -> bool:
        """暂停跳转也必须先生产到目标帧，不能在回退预读的第一个分片就挂起。"""
        frame = 1 / max(1, session.info.frame_rate)
        required_end = min(session.info.duration, session.position + frame)
        start = end = None
        for segment in cache.playable_segments(session.segments):
            if end is None or segment.source_start > end + 0.001:
                start = segment.source_start
            end = max(end or 0, segment.source_start + segment.duration)
            if start <= session.position + max(0.01, 2 * frame) and end >= required_end:
                return True
        return False

    async def _refresh(self, session: PlaybackSession) -> None:
        before = self.snapshot(session)
        try:
            await self._refresh_state(session)
        finally:
            if before != self.snapshot(session):
                self._notify(session)

    async def _refresh_state(self, session: PlaybackSession) -> None:
        if session.mode == "direct":
            if (session.status == "paused" and session.leased and session.paused_since
                    and time.monotonic() - session.paused_since >= 60):
                leases.release_source(session.media.source_id)
                session.leased = False
                session.process_state = "released"
            return
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
        if session.mode == "remux" and any(duration > 6 for _, _, duration in entries):
            self._fallback_transcode(session, "源视频关键帧间隔过长，已回退到转码")
            return
        for sequence, (generation, path, duration, task) in sorted(session.pending_probes.items()):
            if not task.done():
                continue
            if sequence > 0 and sequence - 1 in session.pending_probes:
                continue
            del session.pending_probes[sequence]
            if generation != session.generation:
                continue
            source_start = max(0, task.result() - transcode.TIMESTAMP_OFFSET)
            if (not session.segments
                    and source_start > session.position + max(0.01, 2 / session.info.frame_rate)
                    and sequence == 0):
                if session.seek_preroll < transcode.MAX_SEEK_PREROLL:
                    # 仅向目标前有限回退一次；禁止静默从片头解码到任意远目标。
                    session.seek_preroll = transcode.MAX_SEEK_PREROLL
                    self._restart(session)
                else:
                    if session.mode == "remux":
                        self._fallback_transcode(session, "源视频索引无法准确定位，已回退到转码")
                    else:
                        await self._fail(session, "seek_index_unavailable",
                                         "片源无法在目标前定位关键帧，请尝试附近位置或更换片源")
                return
            session.segments[sequence] = cache.Segment(
                sequence, path, source_start, duration, time.monotonic(),
            )
            published = sorted([*session.produced_ranges, (source_start, source_start + duration)])
            session.produced_ranges = []
            for start, end in published:
                if session.produced_ranges and start <= session.produced_ranges[-1][1] + 0.001:
                    previous_start, previous_end = session.produced_ranges[-1]
                    session.produced_ranges[-1] = (previous_start, max(previous_end, end))
                else:
                    session.produced_ranges.append((start, end))
        for sequence, name, duration in entries:
            if sequence in session.segments or sequence in session.pending_probes:
                continue
            if len(session.pending_probes) >= 4:
                break
            path = session.generation_directory / name
            if not path.is_file():
                continue
            if session.timings["first_segment_ms"] is None:
                session.timings["first_segment_ms"] = (
                    time.perf_counter() - session.prepare_started
                ) * 1000
            task = asyncio.create_task(self._probe_segment(path))
            self.probe_tasks.add(task)
            task.add_done_callback(self._probe_finished)
            session.pending_probes[sequence] = (session.generation, path, duration, task)
        if self._target_available(session) and session.status == "preparing":
            first = min(session.segments.values(), key=lambda segment: segment.sequence)
            session.source_anchor = first.source_start
            session.media_anchor = first.source_start + transcode.TIMESTAMP_OFFSET
            session.status = "paused" if session.paused else "ready"
            session.last_ready_generation = session.generation
            session.timings["ready_ms"] = (time.perf_counter() - session.prepare_started) * 1000
        cache.prune(session.segments, session.position)
        unregistered = any(
            sequence not in session.segments and (session.generation_directory / name).is_file()
            for sequence, name, _ in entries
        )
        session.ended = (ended and process.returncode == 0
                         and not session.pending_probes and not unregistered)
        if process.returncode is not None:
            if process.returncode != 0:
                if session.mode == "remux" and not session.segments:
                    self._fallback_transcode(session, "源文件无法直接串流，已回退到转码")
                elif (session.mode == "transcode" and settings.playback_encoder != "libx264"
                        and not session.fallback_used
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
                if session.status == "preparing":
                    await self._fail(session, "seek_empty", "已到达片源结尾，但目标帧仍不可播放")
                    return
                session.process_state = "exited"
                self._queue_stop(session, "complete")
            return
        if session.paused and self._target_available(session):
            process.suspend()
            session.process_state = "user_paused"
            if session.paused_since and time.monotonic() - session.paused_since >= 60:
                session.process_state = "released"
                self._queue_stop(session, "pause")
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

    def _fallback_transcode(self, session: PlaybackSession, reason: str) -> None:
        session.force_transcode = True
        session.plan = replace(plan_playback(
            session.info, session.quality, session.audio_track, session.capabilities,
            force_transcode=True, max_bitrate=session.max_bitrate,
        ), reason=reason)
        self._restart(session)

    async def _probe_segment(self, path: Path) -> float:
        async with self.probe_slots:
            return await transcode.video_start(path)

    def _probe_finished(self, task: asyncio.Task) -> None:
        self.probe_tasks.discard(task)
        self.refresh_requested.set()
        if not task.cancelled():
            task.exception()  # 即使旧代次已放弃，也读取异常避免未处理任务警告。

    def _cancel_probes(self, session: PlaybackSession) -> None:
        for _, _, _, task in session.pending_probes.values():
            task.cancel()
        session.pending_probes.clear()

    async def _cleanup(self, session: PlaybackSession) -> None:
        if (session.process_lock.locked() or session.process
                or session.stop_task and not session.stop_task.done()):
            return
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
                    or int(directory.name.partition("-")[2]) in session.stopping_generations
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
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self.refresh_requested.wait(), 0.25)
            self.refresh_requested.clear()
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
