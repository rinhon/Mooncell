"""真实原文件 Range、视频流复制和模式切换回归。"""

import asyncio
import hashlib
import json
import shutil
import subprocess
import time
import uuid

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI

from app.config import settings
from app.playback import leases, session_router, transcode
from app.playback.media import MediaError, ResolvedMedia, file_version
from app.playback.probe import parse_probe
from app.playback.router import require_playback_user
from app.playback.schemas import ClientPlaybackCapabilities
from app.playback.sessions import SessionManager


@pytest.fixture
def source_factory(tmp_path):
    if not shutil.which(settings.playback_ffmpeg) or not shutil.which(settings.playback_ffprobe):
        pytest.skip("需要本机真实 FFmpeg/FFprobe")

    def make(*, extension="mkv", gop=96, audio_codec="aac", audio_tracks=2):
        path = tmp_path / f"{uuid.uuid4().hex}.{extension}"
        arguments = [settings.playback_ffmpeg, "-hide_banner", "-v", "error", "-y",
                     "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24"]
        for frequency in (440, 880)[:audio_tracks]:
            arguments += ["-f", "lavfi", "-i", f"sine=frequency={frequency}:sample_rate=48000"]
        arguments += ["-map", "0:v:0"]
        for index in range(audio_tracks):
            arguments += ["-map", f"{index + 1}:a:0"]
        arguments += ["-t", "16", "-c:v", "libx264", "-preset", "ultrafast", "-threads", "2",
                      "-g", str(gop), "-keyint_min", str(gop), "-sc_threshold", "0", "-bf", "2"]
        if audio_tracks:
            arguments += ["-c:a", audio_codec, "-ac", "2"]
        subprocess.run([*arguments, str(path)], capture_output=True, check=True, timeout=30)
        stat = path.stat()
        version = file_version(path.name, stat.st_size, stat.st_mtime_ns)
        media_id = hashlib.sha256(path.name.encode()).hexdigest()
        media = ResolvedMedia(media_id, 97654, path, version, stat.st_size, stat.st_mtime_ns,
                              tmp_path, tmp_path, path.name)
        output = subprocess.run([
            settings.playback_ffprobe, "-v", "error", "-show_streams", "-show_format",
            "-of", "json", str(path),
        ], capture_output=True, check=True, timeout=20)
        info = parse_probe(media, json.loads(output.stdout))
        return media, info

    return make


@pytest_asyncio.fixture
async def manager(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "playback_cache_path", str(tmp_path / "playback-cache"))
    monkeypatch.setattr(settings, "playback_encoder", "libx264")
    monkeypatch.setattr(settings, "playback_min_free_mb", 0)
    monkeypatch.setattr(settings, "playback_max_sessions", 1)
    monkeypatch.setattr(settings, "playback_max_remux_sessions", 2)
    manager = SessionManager()
    await manager.start()
    yield manager
    await manager.shutdown()


def capabilities(info):
    return ClientPlaybackCapabilities(
        native_mime_types=[info.native_mime_type] if info.native_mime_type else [],
        hls_mime_types=[info.hls_mime_type] if info.hls_mime_type else [],
    )


async def ready(manager, session_id):
    async with asyncio.timeout(20):
        state = await manager.status(1, session_id)
        while state["status"] not in {"ready", "paused", "failed"}:
            state = await manager.status(1, session_id, state["revision"], 1500)
        assert state["status"] != "failed", state["error"]
        return state


async def create(manager, media, info, **kwargs):
    return await manager.create(1, media, info, 0, 0, None, str(uuid.uuid4()), **kwargs)


@pytest.mark.asyncio
async def test_direct_range_head_auth_and_response_lease(manager, source_factory, monkeypatch):
    media, info = source_factory(extension="mp4", audio_tracks=1)
    assert info.native_mime_type
    state = await create(manager, media, info, capabilities=capabilities(info))
    session = manager.get(1, state["id"])
    assert state["playback_mode"] == "direct" and state["status"] == "ready"
    assert state["quality"] == 0 and state["timeline_mode"] == "source"
    assert not session.directory.exists() and session.process is None
    app = FastAPI()
    app.include_router(session_router.router, prefix="/api/v1")
    monkeypatch.setattr(session_router, "manager", manager)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test",
    ) as client:
        assert (await client.get(state["stream_url"])).status_code == 401
        app.dependency_overrides[require_playback_user] = lambda: 2
        assert (await client.get(state["stream_url"])).status_code == 404
        app.dependency_overrides[require_playback_user] = lambda: 1
        response = await client.get(state["stream_url"], headers={"Range": "bytes=17-47"})
        assert response.status_code == 206
        assert response.content == media.path.read_bytes()[17:48]
        assert response.headers["content-range"] == f"bytes 17-47/{media.size}"
        assert response.headers["etag"] == f'"{media.version}"'
        assert leases._readers[media.source_id] == 1  # 会话仍持有，响应已释放。
        head = await client.head(state["stream_url"])
        assert head.status_code == 200 and not head.content
        assert int(head.headers["content-length"]) == media.size
        invalid = await client.get(state["stream_url"], headers={"Range": "bytes=999999999-"})
        assert invalid.status_code == 416 and leases._readers[media.source_id] == 1
    acknowledgment = await manager.seek(1, session.id, 1, 11.3, str(uuid.uuid4()))
    assert acknowledgment["generation"] == 1 and not acknowledgment["requires_reload"]
    assert acknowledgment["position"] == 11.3
    # 一个在途原文件响应独立持有租约，关闭会话不能提前允许迁移。
    retained = await manager.open_direct(1, session.id, 1)
    await manager.close(1, session.id)
    assert leases.source_in_use(media.source_id)
    leases.release_source(retained.source_id)
    assert not leases.source_in_use(media.source_id)


@pytest.mark.asyncio
async def test_direct_does_not_consume_encoder_slot_or_cache_quota(
    manager, source_factory, monkeypatch,
):
    async def no_prepare(*args):
        pass

    monkeypatch.setattr(manager, "_prepare", no_prepare)
    media, info = source_factory(extension="mp4", audio_tracks=1)
    transcode_state = await create(manager, media, info)
    assert transcode_state["playback_mode"] == "transcode"
    monkeypatch.setattr(settings, "playback_session_quota_mb", 1)
    direct = await create(manager, media, info, capabilities=capabilities(info))
    assert direct["status"] == "ready" and direct["playback_mode"] == "direct"
    assert not manager._has_slot(mode="transcode")
    assert manager._has_slot(mode="direct")
    assert not manager.get(1, direct["id"]).directory.exists()


@pytest.mark.asyncio
async def test_direct_pause_releases_source_and_resumes_without_generation_change(
    manager, source_factory,
):
    media, info = source_factory(extension="mp4", audio_tracks=1)
    state = await create(manager, media, info, capabilities=capabilities(info))
    session = manager.get(1, state["id"])
    await manager.heartbeat(1, session.id, 1, 1, True, 1)
    session.paused_since = time.monotonic() - 61
    async with manager.lock:
        await manager._refresh(session)
    assert not leases.source_in_use(media.source_id) and session.process_state == "released"
    resumed = await manager.heartbeat(1, session.id, 1, 1, False, 1)
    assert resumed["generation"] == 1 and resumed["status"] == "ready"
    assert leases.source_in_use(media.source_id) and session.process is None


@pytest.mark.asyncio
async def test_direct_options_force_transcode_and_switch_back(manager, source_factory):
    media, info = source_factory(extension="mp4", audio_tracks=1)
    state = await create(manager, media, info, capabilities=capabilities(info))
    switched = await manager.seek(1, state["id"], 1, 7.3, str(uuid.uuid4()), force_transcode=True)
    assert switched["playback_mode"] == "transcode" and switched["generation"] == 2
    encoded = await ready(manager, state["id"])
    assert encoded["quality"] == 0 and encoded["source_anchor"] == pytest.approx(7.3333, abs=0.01)
    restored = await manager.seek(
        1, state["id"], encoded["generation"], 9, str(uuid.uuid4()), force_transcode=False,
    )
    assert restored["playback_mode"] == "direct"
    final = await ready(manager, state["id"])
    assert final["timeline_mode"] == "source" and final["source_anchor"] == 0
    assert manager.get(1, state["id"]).process is None


@pytest.mark.asyncio
@pytest.mark.parametrize("audio_codec", ["aac", "flac"])
async def test_real_mkv_remux_copies_video_maps_audio_and_seeks(
    manager, source_factory, audio_codec,
):
    media, info = source_factory(audio_codec=audio_codec)
    assert info.hls_mime_type and not info.native_mime_type
    state = await manager.create(
        1, media, info, 0, 0, info.audio_tracks[1].id, str(uuid.uuid4()),
        capabilities=capabilities(info),
    )
    assert state["playback_mode"] == "remux"
    session = manager.get(1, state["id"])
    arguments = transcode.command(media, info, session.generation_directory, 0, 720,
                                  info.audio_tracks[1].id, plan=session.plan)
    assert arguments[arguments.index("-c:v") + 1] == "copy"
    assert arguments[arguments.index("-c:a") + 1] == ("copy" if audio_codec == "aac" else "aac")
    assert f"0:{info.audio_tracks[1].id}" in arguments
    assert "-vf" not in arguments and "-force_key_frames" not in arguments
    first = await ready(manager, session.id)
    playlist = await manager.playlist(1, session.id, first["generation"])
    assert "#EXT-X-TARGETDURATION:6" in playlist
    assert "#EXT-X-INDEPENDENT-SEGMENTS" not in playlist
    async with asyncio.timeout(10):
        while len(session.segments) < 2:
            await asyncio.sleep(0.05)
    for segment in list(session.segments.values())[:2]:
        result = subprocess.run([
            settings.playback_ffmpeg, "-hide_banner", "-v", "error", "-xerror", "-i",
            str(segment.path), "-frames:v", "1", "-f", "null", "-",
        ], capture_output=True, timeout=20)
        assert result.returncode == 0, result.stderr.decode(errors="replace")
    async with manager.lock:
        session.segments = {0: session.segments[0]}
    await manager.seek(1, session.id, first["generation"], 11.3, str(uuid.uuid4()))
    sought = await ready(manager, session.id)
    assert sought["playback_mode"] == "remux"
    assert sought["source_anchor"] <= 11.3 + 0.1
    assert 0 <= 11.3 - sought["source_anchor"] < 4.1
    assert sought["position"] == 11.3


@pytest.mark.asyncio
async def test_long_gop_remux_falls_back_before_publishing_invalid_playlist(
    manager, source_factory,
):
    media, info = source_factory(gop=240, audio_tracks=1)
    state = await create(manager, media, info, capabilities=capabilities(info))
    assert state["playback_mode"] == "remux"
    playable = await ready(manager, state["id"])
    assert playable["playback_mode"] == "transcode" and playable["generation"] == 2
    assert "关键帧间隔过长" in playable["mode_reason"]
    assert "#EXT-X-TARGETDURATION:3" in await manager.playlist(1, state["id"], 2)


@pytest.mark.asyncio
async def test_remux_limit_is_separate_from_transcode_limit(manager, source_factory, monkeypatch):
    async def no_prepare(*args):
        pass

    monkeypatch.setattr(manager, "_prepare", no_prepare)
    media, info = source_factory(audio_tracks=1)
    for _ in range(2):
        state = await create(manager, media, info, capabilities=capabilities(info))
        assert state["playback_mode"] == "remux"
    with pytest.raises(MediaError) as busy:
        await create(manager, media, info, capabilities=capabilities(info))
    assert busy.value.code == "transcode_busy"
    assert (await create(manager, media, info))["playback_mode"] == "transcode"


@pytest.mark.asyncio
async def test_direct_file_version_is_checked_before_acquiring_response_lease(
    manager, source_factory,
):
    media, info = source_factory(extension="mp4", audio_tracks=1)
    state = await create(manager, media, info, capabilities=capabilities(info))
    media.path.write_bytes(b"replaced")
    with pytest.raises(MediaError) as replaced:
        await manager.open_direct(1, state["id"], 1)
    assert replaced.value.code == "media_changed"
    assert leases._readers[media.source_id] == 1


@pytest.mark.asyncio
async def test_high_bitrate_remux_is_rejected_before_start_when_cache_budget_is_too_small(
    manager, source_factory, monkeypatch,
):
    from app.playback import sessions

    class UnexpectedProcess:
        def __init__(self):
            pytest.fail("高码率片源的缓存预算不足时不得启动 FFmpeg")

    media, info = source_factory(audio_tracks=1)
    info = info.model_copy(update={"bit_rate": 500_000_000})
    monkeypatch.setattr(sessions, "OwnedProcess", UnexpectedProcess)
    state = await create(manager, media, info, capabilities=capabilities(info))
    session = manager.get(1, state["id"])
    await session.task
    if session.stop_task:
        await session.stop_task
    assert session.status == "failed" and session.error["code"] == "cache_limit"
    assert session.process is None and not leases.source_in_use(media.source_id)


@pytest.mark.asyncio
@pytest.mark.parametrize("bitrate", [256_000, 1_000_000])
async def test_capped_transcode_enforces_video_budget_and_uncapped_command_is_unchanged(
    manager, source_factory, bitrate,
):
    media, info = source_factory(extension="mp4", audio_tracks=1)
    state = await create(manager, media, info, force_transcode=True, max_bitrate=bitrate)
    session = manager.get(1, state["id"])
    command = transcode.command(media, info, session.generation_directory, 0,
                                session.plan.output_quality, None, plan=session.plan)
    video = int(command[command.index("-maxrate") + 1])
    target = int(command[command.index("-b:v") + 1])
    assert target <= video and video + 128_000 <= bitrate * 9 // 10
    assert int(command[command.index("-bufsize") + 1]) == video * 2
    uncapped = transcode.command(media, info, session.generation_directory, 0,
                                 session.plan.output_quality, None)
    assert uncapped[uncapped.index("-b:v") + 1] == "2800k"
    assert uncapped[uncapped.index("-maxrate") + 1] == "6000k"
    assert uncapped[uncapped.index("-bufsize") + 1] == "12000k"
    playable = await ready(manager, session.id)
    assert playable["playback_mode"] == "transcode"
    segment = session.segments[0]
    decoded = subprocess.run([
        settings.playback_ffmpeg, "-hide_banner", "-v", "error", "-xerror", "-i",
        str(segment.path), "-frames:v", "1", "-f", "null", "-",
    ], capture_output=True, timeout=20)
    assert decoded.returncode == 0, decoded.stderr.decode(errors="replace")


@pytest.mark.asyncio
async def test_paused_ts_remux_produces_through_seek_target_before_becoming_ready(
    manager, source_factory, monkeypatch,
):
    media, info = source_factory(extension="ts", audio_tracks=1)
    target_ready, release_target = asyncio.Event(), asyncio.Event()
    original = transcode.video_start

    async def delay_target(path):
        if path.name == "segment-0000002.ts":
            target_ready.set()
            await release_target.wait()
        return await original(path)

    monkeypatch.setattr(transcode, "video_start", delay_target)
    created = await manager.create(
        1, media, info, 11.3, 0, None, str(uuid.uuid4()), capabilities=capabilities(info),
    )
    session = manager.get(1, created["id"])
    assert created["playback_mode"] == "remux"
    await manager.heartbeat(1, session.id, 1, 11.3, True, 1)
    try:
        await asyncio.wait_for(target_ready.wait(), timeout=10)
        async with asyncio.timeout(2):
            while not session.segments:
                await asyncio.sleep(0.01)
        assert session.status == "preparing" and not manager._target_available(session)
        assert session.process is not None and not session.process.suspended
        state = await manager.heartbeat(1, session.id, 1, 11.3, True, 1)
        assert state["status"] == "preparing" and not session.process.suspended
    finally:
        release_target.set()
    state = await ready(manager, session.id)
    assert state["status"] == "paused" and state["position"] == 11.3
    assert manager._target_available(session)
    assert max(segment.source_start + segment.duration
               for segment in session.segments.values()) > 11.3
