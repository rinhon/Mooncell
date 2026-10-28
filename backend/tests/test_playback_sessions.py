"""真实 FFmpeg 分片/跳转及会话、缓存与进程生命周期回归。"""

import asyncio
import json
import shutil
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

import pytest
import pytest_asyncio

from app.config import settings
from app.playback import cache, leases, transcode
from app.playback.media import MediaError, ResolvedMedia, file_version
from app.playback.processes import OwnedProcess
from app.playback.schemas import PlaybackInfo
from app.playback.sessions import SessionManager


@pytest.fixture
def sample(tmp_path):
    if not shutil.which(settings.playback_ffmpeg) or not shutil.which(settings.playback_ffprobe):
        pytest.skip("需要本机真实 FFmpeg/FFprobe")
    path = tmp_path / "sample.mp4"
    subprocess.run(
        [
            settings.playback_ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x180:rate=24",
            "-t",
            "15",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-threads",
            "2",
            "-g",
            "120",
            str(path),
        ],
        check=True,
        capture_output=True,
        timeout=30,
    )
    stat = path.stat()
    version = file_version(path.name, stat.st_size, stat.st_mtime_ns)
    media = ResolvedMedia(
        "a" * 64,
        98765,
        path,
        version,
        stat.st_size,
        stat.st_mtime_ns,
        tmp_path,
        tmp_path,
        path.name,
    )
    info = PlaybackInfo(
        media_id=media.media_id,
        source_id=media.source_id,
        filename=path.name,
        version=version,
        duration=15,
        video_width=320,
        video_height=180,
        video_codec="h264",
        qualities=[720],
    )
    return media, info


@pytest_asyncio.fixture
async def session_manager(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "playback_cache_path", str(tmp_path / "cache"))
    monkeypatch.setattr(settings, "playback_encoder", "libx264")
    monkeypatch.setattr(settings, "playback_min_free_mb", 0)
    manager = SessionManager()
    await manager.start()
    yield manager
    await manager.shutdown()


async def ready(manager, session_id, user_id=1):
    async with asyncio.timeout(15):
        while True:
            status = await manager.status(user_id, session_id)
            if status["status"] == "failed":
                pytest.fail(str(status))
            if status["status"] in {"ready", "paused"}:
                return status
            await asyncio.sleep(0.05)


@pytest.mark.asyncio
async def test_real_hls_seek_pts_ownership_idempotence_and_readers(session_manager, sample):
    manager = session_manager
    media, info = sample
    request_id = str(uuid.uuid4())
    first, duplicate = await asyncio.gather(
        manager.create(1, media, info, 0, 720, None, request_id),
        manager.create(1, media, info, 0, 720, None, request_id),
    )
    assert first["id"] == duplicate["id"]
    assert first["status"] == "preparing"
    session_id = first["id"]
    status = await ready(manager, session_id)
    assert status["segments"][0]["source_start"] == pytest.approx(0, abs=0.05)
    assert status["segments"][0]["duration"] == pytest.approx(3, abs=0.05)
    assert status["revision"] > first["revision"]
    assert status["timings"]["spawn_ms"] >= 0
    assert 0 <= status["timings"]["first_segment_ms"] <= status["timings"]["ready_ms"]
    playlist = await manager.playlist(1, session_id, 1)
    assert "#EXT-X-PLAYLIST-TYPE" not in playlist
    assert "segments/segment-0000000.ts" in playlist
    with pytest.raises(MediaError, match="不存在") as ownership:
        await manager.status(2, session_id)
    assert ownership.value.status == 404
    segment = await manager.open_segment(1, session_id, 1, "segment-0000000.ts")
    old_directory = segment.path.parent
    async with manager.lock:
        session = manager.get(1, session_id)
        session.segments = {0: session.segments[0]}  # 模拟仅保留开头缓存窗口。
    seeking = await manager.seek(1, session_id, 1, 7.3, str(uuid.uuid4()))
    assert seeking["generation"] == 2
    status = await ready(manager, session_id)
    assert status["segments"][0]["source_start"] == pytest.approx(7.333333, abs=0.002)
    with pytest.raises(MediaError) as stale:
        await manager.playlist(1, session_id, 1)
    assert stale.value.code == "stale_generation"
    session = manager.get(1, session_id)
    session.retired_directories = [(old_directory, 0)]
    manager._cleanup_retired(session)
    assert segment.path.exists()  # 旧代次的在途响应仍有独立引用保护。
    await manager.release_segment(segment)
    manager._cleanup_retired(session)
    assert not old_directory.exists()
    await manager.close(1, session_id)
    await manager.close(1, session_id)
    assert manager.validate_progress(1, media.media_id, session_id, 2) == session.created_at
    assert not leases.source_in_use(media.source_id)


@pytest.mark.asyncio
async def test_long_pause_releases_and_resume_rebuilds(session_manager, sample):
    manager = session_manager
    media, info = sample
    created = await manager.create(1, media, info, 0, 720, None, str(uuid.uuid4()))
    await ready(manager, created["id"])
    session = manager.get(1, created["id"])

    class RunningProcess:
        running = True
        suspended = False
        returncode = None
        out_time = 0
        last_progress = time.monotonic()

        def suspend(self):
            self.suspended = True

        def resume(self):
            self.suspended = False

        async def stop(self, *, fast=False):
            self.running = False

    process = RunningProcess()
    await manager._stop_process(session)
    async with manager.lock:
        session.process, session.process_generation = process, session.generation
        leases.acquire_source(media.source_id)
        session.leased = True
    paused = await manager.heartbeat(1, session.id, 1, 1.0, True, 1)
    assert paused["status"] == "paused"
    assert process.suspended
    session.paused_since = time.monotonic() - 61
    async with manager.lock:
        await manager._refresh(session)
    if session.stop_task:
        await session.stop_task
    assert session.process is None and session.process_state == "released"
    assert not leases.source_in_use(media.source_id)
    resumed = await manager.heartbeat(1, session.id, 1, 1.0, False, 1)
    assert resumed["generation"] == 2
    assert resumed["status"] == "preparing"
    result = await ready(manager, session.id)
    assert result["source_anchor"] == pytest.approx(1.0, abs=0.05)


@pytest.mark.asyncio
async def test_rejects_heartbeat_jumps_and_quota_without_start(
    session_manager,
    sample,
    monkeypatch,
):
    manager = session_manager
    media, info = sample
    monkeypatch.setattr(settings, "playback_session_quota_mb", 1)
    with pytest.raises(MediaError) as quota:
        await manager.create(1, media, info, 0, 720, None, str(uuid.uuid4()))
    assert quota.value.code == "cache_limit"
    assert not manager.sessions
    monkeypatch.setattr(settings, "playback_session_quota_mb", 512)
    created = await manager.create(1, media, info, 0, 720, None, str(uuid.uuid4()))
    await ready(manager, created["id"])
    with pytest.raises(MediaError) as invalid:
        await manager.heartbeat(1, created["id"], 1, float("inf"), False, 1)
    assert invalid.value.code == "invalid_position"
    with pytest.raises(MediaError) as old:
        manager.validate_progress(1, media.media_id, created["id"], 99)
    assert old.value.code == "stale_generation"


def test_cache_retains_readers_and_grace_and_ignores_foreign_files(tmp_path):
    own = cache.session_directory(tmp_path, "a" * 32)
    path = own / "segment-0000000.ts"
    path.write_bytes(b"test")
    segment = cache.Segment(0, path, 0, 3, 0, readers=1)
    segments = {0: segment}
    cache.prune(segments, 100)
    assert path.exists()
    segment.readers = 0
    segment.last_access = time.monotonic()
    cache.prune(segments, 100)
    assert path.exists()
    segment.last_access = 0
    cache.prune(segments, 100)
    assert not path.exists() and not segments
    foreign = tmp_path / "my-video"
    foreign.mkdir()
    cache.remove_owned(tmp_path, foreign)
    assert foreign.exists()
    cache.remove_owned(tmp_path, own)
    assert not own.exists()


def test_cache_prune_keeps_contiguous_prefix_when_first_segment_has_reader(tmp_path):
    segments = {}
    for sequence in range(4):
        path = tmp_path / f"segment-{sequence:07d}.ts"
        path.write_bytes(b"test")
        segments[sequence] = cache.Segment(sequence, path, sequence * 3, 3, 0)
    segments[0].readers = 1
    cache.prune(segments, 100)
    assert list(segments) == [0, 1, 2, 3]
    assert "#EXT-X-MEDIA-SEQUENCE:0" in cache.make_playlist(segments, False)
    segments[0].readers = 0
    cache.prune(segments, 100)
    assert not segments


@pytest.mark.asyncio
async def test_invalid_create_does_not_make_session_directory(session_manager, sample):
    media, info = sample
    for start, quality in ((-1, 720), (float("nan"), 720), (0, 1080)):
        with pytest.raises(MediaError):
            await session_manager.create(1, media, info, start, quality, None, str(uuid.uuid4()))
    assert not list(session_manager.root.glob("session-*"))
    assert not leases.source_in_use(media.source_id)


@pytest.mark.asyncio
async def test_endlist_waits_for_all_pending_probes_and_releases_source(
    session_manager,
    sample,
    monkeypatch,
):
    media, info = sample
    last_probe = asyncio.Event()
    entered = asyncio.Event()
    original_probe = transcode.video_start

    async def delayed_last(path):
        if path.name == "segment-0000004.ts":
            entered.set()
            await last_probe.wait()
        return await original_probe(path)

    monkeypatch.setattr(transcode, "video_start", delayed_last)
    created = await session_manager.create(1, media, info, 0, 720, None, str(uuid.uuid4()))
    await ready(session_manager, created["id"])
    await asyncio.wait_for(entered.wait(), timeout=15)
    assert "#EXT-X-ENDLIST" not in await session_manager.playlist(1, created["id"], 1)
    last_probe.set()
    async with asyncio.timeout(15):
        while True:
            session = session_manager.get(1, created["id"])
            if session.ended and session.stop_task is not None:
                # 回收任务在锁内摘下进程，锁外等待管道/线程退出后才释放媒体租约。
                # process=None 只说明控制路径已让出进程，不代表清理已完成。
                await asyncio.shield(session.stop_task)
                break
            await asyncio.sleep(0.05)
    assert session.process is None and not session.leased
    assert len(session.segments) == 5
    assert "#EXT-X-ENDLIST" in await session_manager.playlist(1, created["id"], 1)
    assert not leases.source_in_use(media.source_id)


def test_cache_root_lock_is_exclusive_across_processes(tmp_path):
    lock = cache.CacheLock(tmp_path)
    command = [
        sys.executable,
        "-c",
        "from pathlib import Path; from app.playback.cache import CacheLock; "
        "import sys; lock=CacheLock(Path(sys.argv[1])); lock.close()",
        str(tmp_path),
    ]
    try:
        rejected = subprocess.run(command, capture_output=True, timeout=30, check=False)
        assert rejected.returncode != 0
        assert b"RuntimeError" in rejected.stderr
    finally:
        lock.close()
    accepted = subprocess.run(command, capture_output=True, timeout=30, check=False)
    assert accepted.returncode == 0, accepted.stderr


@pytest.mark.asyncio
async def test_nonzero_source_start_still_uses_zero_based_source_time(
    session_manager,
    sample,
    tmp_path,
):
    media, info = sample
    path = tmp_path / "nonzero.ts"
    subprocess.run(
        [
            settings.playback_ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(media.path),
            "-c",
            "copy",
            "-output_ts_offset",
            "5",
            "-muxdelay",
            "0",
            str(path),
        ],
        check=True,
        capture_output=True,
        timeout=30,
    )
    stat = path.stat()
    version = file_version(path.name, stat.st_size, stat.st_mtime_ns)
    media = ResolvedMedia(
        "b" * 64,
        media.source_id,
        path,
        version,
        stat.st_size,
        stat.st_mtime_ns,
        tmp_path,
        tmp_path,
        path.name,
    )
    info = info.model_copy(update={"media_id": media.media_id, "version": version})
    created = await session_manager.create(1, media, info, 0, 720, None, str(uuid.uuid4()))
    status = await ready(session_manager, created["id"])
    assert status["source_anchor"] == pytest.approx(0, abs=0.05)
    async with session_manager.lock:
        session = session_manager.get(1, created["id"])
        session.segments = {0: session.segments[0]}
    await session_manager.seek(1, created["id"], 1, 7.3, str(uuid.uuid4()))
    sought = await ready(session_manager, created["id"])
    assert sought["source_anchor"] == pytest.approx(7.333333, abs=0.002)


@pytest.mark.asyncio
async def test_cached_seek_keeps_generation_and_resets_heartbeat_anchor(session_manager, sample):
    media, info = sample
    created = await session_manager.create(1, media, info, 0, 720, None, str(uuid.uuid4()))
    status = await ready(session_manager, created["id"])
    target = min(2.0, status["cached_ranges"][0][1] - 0.1)
    result = await session_manager.seek(1, created["id"], 1, target, str(uuid.uuid4()))
    assert result["generation"] == 1
    session = session_manager.get(1, created["id"])
    assert session.position == target
    assert session.last_heartbeat == session.last_active
    await session_manager.heartbeat(1, created["id"], 1, target + 0.01, False, 1)


@pytest.mark.asyncio
async def test_repeated_heartbeat_does_not_refresh_fifteen_second_budget(session_manager, sample):
    media, info = sample
    info = info.model_copy(update={"duration": 1000})
    created = await session_manager.create(1, media, info, 0, 720, None, str(uuid.uuid4()))
    await session_manager.heartbeat(1, created["id"], 1, 14.9, False, 1)
    with pytest.raises(MediaError) as skipped:
        await session_manager.heartbeat(1, created["id"], 1, 29.0, False, 1)
    assert skipped.value.code == "position_discontinuity"


@pytest.mark.asyncio
async def test_same_tab_refresh_replaces_own_process_without_stealing_other_clients(
    session_manager,
    sample,
):
    media, info = sample
    client_id, request_id = str(uuid.uuid4()), str(uuid.uuid4())
    created = await session_manager.create(1, media, info, 0, 720, None, request_id, client_id)
    old_session = session_manager.get(1, created["id"])
    async with asyncio.timeout(10):
        while old_session.process is None:
            await asyncio.sleep(0.01)
    old_process = old_session.process
    assert old_process.running
    # 响应重试首先走幂等，不关闭仍在准备的同标签页会话。
    repeated = await session_manager.create(1, media, info, 0, 720, None, request_id, client_id)
    assert repeated["id"] == created["id"] and old_session.status != "closed"
    for user_id, other_client in ((2, client_id), (1, str(uuid.uuid4())), (1, None)):
        with pytest.raises(MediaError) as busy:
            await session_manager.create(
                user_id,
                media,
                info,
                0,
                720,
                None,
                str(uuid.uuid4()),
                other_client,
            )
        assert busy.value.code == "transcode_busy"
        assert old_session.status != "closed" and old_process.running
    refreshed = await session_manager.create(
        1,
        media,
        info,
        7.3,
        720,
        None,
        str(uuid.uuid4()),
        client_id,
    )
    assert old_session.status == "closed" and not old_process.running
    assert refreshed["id"] != created["id"] and refreshed["generation"] == 1
    status = await ready(session_manager, refreshed["id"])
    assert status["source_anchor"] == pytest.approx(7.333333, abs=0.002)


@pytest.mark.asyncio
async def test_slow_segment_probe_does_not_hold_control_lock(session_manager, sample, monkeypatch):
    media, info = sample
    blocked = asyncio.Event()

    async def slow_probe(path):
        await blocked.wait()
        return 1.0

    monkeypatch.setattr(transcode, "video_start", slow_probe)
    created = await session_manager.create(1, media, info, 0, 720, None, str(uuid.uuid4()))
    async with asyncio.timeout(10):
        while not session_manager.get(1, created["id"]).pending_probes:
            await asyncio.sleep(0.05)
    status = await asyncio.wait_for(session_manager.status(1, created["id"]), timeout=0.3)
    assert status["status"] == "preparing"
    await asyncio.wait_for(
        session_manager.seek(1, created["id"], 1, 7.3, str(uuid.uuid4())),
        timeout=0.3,
    )


@pytest.mark.asyncio
async def test_segment_response_releases_reader_if_response_start_fails(tmp_path, monkeypatch):
    from starlette.requests import ClientDisconnect

    from app.playback import session_router

    path = tmp_path / "segment-0000000.ts"
    path.write_bytes(b"test")
    segment = cache.Segment(0, path, 0, 3, 0, readers=1)
    released = []

    async def release(item):
        released.append(item)
        item.readers -= 1

    monkeypatch.setattr(session_router.manager, "release_segment", release)

    async def content():
        pytest.fail("response.start 已失败，不应开始迭代正文")
        yield b""

    async def receive():
        await asyncio.sleep(10)

    async def send(message):
        raise OSError("client disconnected before response.start")

    response = session_router.SegmentResponse(segment, content(), {})
    with pytest.raises(ClientDisconnect):
        await response({"type": "http", "asgi": {"spec_version": "2.4"}}, receive, send)
    assert released == [segment] and segment.readers == 0


@pytest.mark.asyncio
async def test_actual_owned_process_suspend_resume_and_stop():
    if not shutil.which(settings.playback_ffmpeg):
        pytest.skip("需要真实 FFmpeg")
    process = OwnedProcess()
    process.start(
        [
            settings.playback_ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostats",
            "-re",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=160x90:rate=24",
            "-t",
            "20",
            "-progress",
            "pipe:1",
            "-f",
            "null",
            "-",
        ]
    )
    try:
        await asyncio.sleep(1.2)
        process.suspend()
        await asyncio.sleep(0.2)
        before = process.out_time
        await asyncio.sleep(0.7)
        assert process.out_time == before
        process.resume()
        await asyncio.sleep(0.8)
        assert process.out_time > before
        process.suspend()
    finally:
        await process.stop()
    assert not process.running and process.returncode == 0


def test_transcode_never_upscales_and_maps_audio_and_disables_external_protocols(sample):
    media, info = sample
    command = transcode.command(media, info, Path("out"), 7.3, 720, None)
    assert command[command.index("-vf") + 1] == "trim=start=7.300000,scale=320:180"
    assert command[command.index("-protocol_whitelist") + 1] == "file,pipe"
    assert "-copyts" in command and "-start_at_zero" in command
    assert "-an" in command
    json.dumps(command)


def test_nvenc_forces_idr_for_independent_three_second_hls_segments(sample):
    media, info = sample
    command = transcode.command(media, info, Path("out"), 0, 720, None, encoder="h264_nvenc")
    assert command[command.index("-forced-idr") + 1] == "1"
    assert command[command.index("-hls_time") + 1] == "3"
    software = transcode.command(media, info, Path("out"), 0, 720, None, encoder="libx264")
    assert "-forced-idr" not in software


@pytest.mark.asyncio
async def test_revision_wait_wakes_for_seek_and_does_not_hold_control_lock(
    session_manager,
    sample,
    monkeypatch,
):
    async def no_prepare(*args):
        pass

    monkeypatch.setattr(session_manager, "_prepare", no_prepare)
    media, info = sample
    created = await session_manager.create(1, media, info, 0, 720, None, str(uuid.uuid4()))
    session = session_manager.get(1, created["id"])
    session.status = "ready"
    session.produced_ranges = [(0, 15)]
    waiting = asyncio.create_task(session_manager.status(1, session.id, session.revision, 1500))
    await asyncio.sleep(0)
    request_id = str(uuid.uuid4())
    ack = await asyncio.wait_for(
        session_manager.seek(
            1,
            session.id,
            1,
            7.3,
            request_id,
            client_buffered=True,
        ),
        timeout=0.3,
    )
    updated = await asyncio.wait_for(waiting, timeout=0.3)
    assert updated["revision"] == ack["revision"] > created["revision"]
    assert ack["generation"] == 1 and ack["seek_revision"] == 1
    assert ack["seek_disposition"] == "buffered"
    assert ack["needs_recovery"] and not ack["requires_reload"]
    assert (
        await session_manager.seek(
            1,
            session.id,
            1,
            7.3,
            request_id,
            client_buffered=True,
        )
    )["revision"] == ack["revision"]
    await session_manager.heartbeat(1, session.id, 1, 7.31, False, 1)
    recovery = await session_manager.seek(1, session.id, 1, 7.4, str(uuid.uuid4()))
    assert recovery["generation"] == 2 and recovery["requires_reload"]
    assert recovery["seek_disposition"] == "restart" and not recovery["needs_recovery"]


@pytest.mark.asyncio
async def test_revision_wait_times_out_and_cancellation_keeps_session_usable(
    session_manager,
    sample,
    monkeypatch,
):
    async def no_prepare(*args):
        pass

    monkeypatch.setattr(session_manager, "_prepare", no_prepare)
    media, info = sample
    created = await session_manager.create(1, media, info, 0, 720, None, str(uuid.uuid4()))
    unchanged = await asyncio.wait_for(
        session_manager.status(
            1,
            created["id"],
            created["revision"],
            20,
        ),
        timeout=0.3,
    )
    assert unchanged["revision"] == created["revision"]
    waiting = asyncio.create_task(
        session_manager.status(
            1,
            created["id"],
            unchanged["revision"],
            1500,
        )
    )
    await asyncio.sleep(0)
    waiting.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiting
    await asyncio.wait_for(session_manager.close(1, created["id"]), timeout=0.3)
    closed = await session_manager.status(1, created["id"], unchanged["revision"], 1500)
    assert closed["status"] == "closed" and closed["revision"] > unchanged["revision"]


@pytest.mark.asyncio
async def test_slow_stop_does_not_block_controls_and_only_latest_seek_starts(
    session_manager,
    sample,
    monkeypatch,
):
    from app.playback import sessions

    entered, release = asyncio.Event(), asyncio.Event()
    starts = []

    class Process:
        running = True
        suspended = False
        returncode = None
        out_time = 0
        last_progress = time.monotonic()

        def start(self, arguments):
            starts.append(arguments)

        async def stop(self, *, fast=False):
            self.running = False

    class SlowOldProcess(Process):
        async def stop(self, *, fast=False):
            assert fast
            entered.set()
            await release.wait()
            self.running = False

    monkeypatch.setattr(sessions, "OwnedProcess", Process)
    media, info = sample
    created = await session_manager.create(1, media, info, 0, 720, None, str(uuid.uuid4()))
    session = session_manager.get(1, created["id"])
    await session.task
    starts.clear()
    session.status = "ready"
    old = SlowOldProcess()
    session.process = old
    first = await session_manager.seek(1, session.id, 1, 7.3, str(uuid.uuid4()))
    try:
        await asyncio.wait_for(entered.wait(), timeout=0.5)
        state = await asyncio.wait_for(session_manager.status(1, session.id), timeout=0.3)
        assert state["generation"] == first["generation"] == 2
        final = await asyncio.wait_for(
            session_manager.seek(
                1,
                session.id,
                1,
                11.3,
                str(uuid.uuid4()),
            ),
            timeout=0.3,
        )
        assert final["generation"] == 3 and not starts
    finally:
        release.set()
    await asyncio.wait_for(session.task, timeout=1)
    assert len(starts) == 1
    assert starts[0][starts[0].index("-ss") + 1] == "11.300000"
    assert session.process_generation == 3 and not old.running
    assert leases.source_in_use(media.source_id)
    await session_manager.close(1, session.id)
    assert not leases.source_in_use(media.source_id)


@pytest.mark.asyncio
async def test_late_first_frame_retries_with_bounded_preroll_then_fails(
    session_manager,
    sample,
    monkeypatch,
):
    async def no_prepare(*args):
        pass

    monkeypatch.setattr(session_manager, "_prepare", no_prepare)
    media, info = sample
    info = info.model_copy(update={"duration": 7200})
    created = await session_manager.create(1, media, info, 5400, 720, None, str(uuid.uuid4()))
    session = session_manager.get(1, created["id"])

    class Process:
        running = False
        returncode = 0

        async def stop(self, *, fast=False):
            pass

    for attempt in range(2):
        session.process, session.process_generation = Process(), session.generation
        timestamp = asyncio.create_task(asyncio.sleep(0, result=5402 + transcode.TIMESTAMP_OFFSET))
        await timestamp
        session.pending_probes[0] = (
            session.generation,
            session.generation_directory / "segment-0000000.ts",
            3,
            timestamp,
        )
        async with session_manager.lock:
            await session_manager._refresh(session)
        if attempt == 0:
            assert session.generation == 2 and session.seek_preroll == 30
            arguments = transcode.command(
                media,
                info,
                session.generation_directory,
                5400,
                720,
                None,
                seek_preroll=session.seek_preroll,
            )
            assert arguments[arguments.index("-ss") + 1] == "5370.000000"
    assert session.generation == 2 and session.status == "failed"
    assert session.error["code"] == "seek_index_unavailable"


@pytest.mark.asyncio
async def test_close_during_spawn_reaps_unpublished_process_and_releases_source(
    session_manager,
    sample,
    monkeypatch,
):
    from app.playback import sessions

    entered, release = threading.Event(), threading.Event()
    spawned = []

    class Process:
        running = True

        def start(self, arguments):
            spawned.append(self)
            entered.set()
            assert release.wait(3)

        async def stop(self, *, fast=False):
            self.running = False

    monkeypatch.setattr(sessions, "OwnedProcess", Process)
    media, info = sample
    created = await session_manager.create(1, media, info, 0, 720, None, str(uuid.uuid4()))
    session = session_manager.get(1, created["id"])
    try:
        async with asyncio.timeout(1):
            while not entered.is_set():
                await asyncio.sleep(0.01)
        await session_manager.seek(1, session.id, 1, 7.3, str(uuid.uuid4()))
        closing = asyncio.create_task(session_manager.close(1, session.id))
        await asyncio.sleep(0)
        state = await asyncio.wait_for(session_manager.status(1, session.id), timeout=0.3)
        assert state["status"] == "closed" and session.process is None
    finally:
        release.set()
    await asyncio.wait_for(closing, timeout=1)
    assert len(spawned) == 1 and not spawned[0].running
    assert not leases.source_in_use(media.source_id)


@pytest.mark.asyncio
async def test_stop_timeout_retains_process_lease_and_slot_until_reaped(
    session_manager,
    sample,
    monkeypatch,
):
    async def no_prepare(*args):
        pass

    monkeypatch.setattr(session_manager, "_prepare", no_prepare)
    media, info = sample
    created = await session_manager.create(1, media, info, 0, 720, None, str(uuid.uuid4()))
    session = session_manager.get(1, created["id"])
    real_prepare = SessionManager._prepare.__get__(session_manager)

    class Process:
        running = True
        blocked = True

        async def stop(self, *, fast=False):
            if self.blocked:
                raise subprocess.TimeoutExpired("ffmpeg", 1)
            self.running = False

    process = Process()
    session.process, session.process_generation = process, 1
    session.status = "ready"
    monkeypatch.setattr(session_manager, "_prepare", real_prepare)
    await session_manager.seek(1, session.id, 1, 7.3, str(uuid.uuid4()))
    await session.task
    if session.stop_task:
        await session.stop_task
    state = await session_manager.status(1, session.id)
    assert state["status"] == "failed" and state["error"]["code"] == "process_stop_failed"
    assert session.process is process and leases.source_in_use(media.source_id)
    assert not session_manager._has_slot()
    process.blocked = False
    await session_manager.close(1, session.id)
    assert not process.running and session.process is None
    assert not leases.source_in_use(media.source_id)


@pytest.mark.asyncio
async def test_old_heartbeat_and_progress_revision_cannot_undo_same_generation_seek(
    session_manager,
    sample,
    monkeypatch,
):
    async def no_prepare(*args):
        pass

    monkeypatch.setattr(session_manager, "_prepare", no_prepare)
    media, info = sample
    created = await session_manager.create(1, media, info, 0, 720, None, str(uuid.uuid4()))
    session = session_manager.get(1, created["id"])
    session.status = "ready"
    session.produced_ranges = [(0, 15)]
    acknowledgment = await session_manager.seek(
        1,
        session.id,
        1,
        10,
        str(uuid.uuid4()),
        client_buffered=True,
    )
    with pytest.raises(MediaError) as stale:
        await session_manager.heartbeat(1, session.id, 1, 1, True, 1, seek_revision=0)
    assert stale.value.code == "stale_seek_revision"
    assert session.position == 10 and not session.paused
    with pytest.raises(MediaError) as old_progress:
        session_manager.validate_progress(1, media.media_id, session.id, 1, seek_revision=0)
    assert old_progress.value.code == "stale_seek_revision"
    await session_manager.heartbeat(
        1,
        session.id,
        1,
        10.01,
        False,
        1,
        seek_revision=acknowledgment["seek_revision"],
    )


@pytest.mark.asyncio
async def test_client_buffer_claim_cannot_expand_producer_budget_across_unpublished_gap(
    session_manager,
    sample,
    monkeypatch,
):
    async def no_prepare(*args):
        pass

    monkeypatch.setattr(session_manager, "_prepare", no_prepare)
    media, info = sample
    created = await session_manager.create(1, media, info, 0, 720, None, str(uuid.uuid4()))
    session = session_manager.get(1, created["id"])
    session.status = "ready"
    session.produced_ranges = [(0, 3), (6, 9)]
    response = await session_manager.seek(
        1,
        session.id,
        1,
        4,
        str(uuid.uuid4()),
        client_buffered=True,
    )
    assert response["generation"] == 2 and response["seek_disposition"] == "restart"
    assert session.produced_ranges == []
