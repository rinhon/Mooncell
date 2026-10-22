import asyncio
import json
import shutil
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import psutil
import pytest
import pytest_asyncio
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api import router as api_router
from app.database import Base, get_session
from app.dependencies import require_user
from app.models import (
    DownloadJob,
    FeedItem,
    FeedSource,
    LibrarySettings,
    MediaFile,
    ShowArtwork,
    User,
)
from app.playback import probe
from app.playback.media import (
    MediaError,
    ResolvedMedia,
    ensure_current,
    file_version,
    register_library_media,
    resolve_media,
    safe_file,
    safe_relative,
)
from app.playback.router import router, save_progress
from app.playback.schemas import ProgressUpdate
from app.show_library import scan_show_library


def resolved(tmp_path: Path) -> ResolvedMedia:
    directory = tmp_path / "作品"
    directory.mkdir(exist_ok=True)
    path = directory / "作品 S01E01.mkv"
    path.write_bytes(b"test-video")
    info = path.stat()
    version = file_version(path.name, info.st_size, info.st_mtime_ns)
    return ResolvedMedia("a" * 64, 1, path, version, info.st_size, info.st_mtime_ns,
                         tmp_path, directory, path.name)


def probe_json(hdr=False):
    return {"format": {"duration": "120.5"}, "streams": [
        {"index": 0, "codec_type": "video", "codec_name": "hevc", "width": 1920,
         "height": 1080, "avg_frame_rate": "24000/1001",
         "color_transfer": "smpte2084" if hdr else "bt709"},
        {"index": 1, "codec_type": "audio", "codec_name": "aac", "channels": 2,
         "tags": {"language": "jpn"}, "disposition": {"default": 1}},
        {"index": 2, "codec_type": "subtitle", "codec_name": "subrip"},
        {"index": 3, "codec_type": "subtitle", "codec_name": "ass"},
    ]}


@pytest_asyncio.fixture
async def media_database(tmp_path):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    media = resolved(tmp_path)
    async with factory() as session:
        source = FeedSource(id=1, name="作品", url="https://example.test/feed")
        source.artwork = ShowArtwork(directory=str(media.directory))
        session.add_all([source, LibrarySettings(id=1, library_root=str(tmp_path)),
                         User(id=1, username="admin", password_hash="unused")])
        await session.commit()
        library = scan_show_library(media.directory, 1)
        await register_library_media(session, 1, library, media.directory)
        media_id = library.seasons[0].items[0].media_id
    yield factory, media, media_id
    await engine.dispose()


@pytest.mark.parametrize("value", [
    "../secret.mkv", "a/../../secret.mkv", "C:/video.mkv", "a\\b.mkv", "/a.mkv",
    "video.mkv:secret", "//server/video.mkv", "./a.mkv", "a//b.mkv", "a/CON.mkv",
    "folder./video.mkv", "a/video.mkv ", "a/\x00.mkv",
])
def test_relative_paths_reject_windows_and_posix_escape(value):
    with pytest.raises(MediaError, match="不安全"):
        safe_relative(value)


def test_safe_file_rejects_outside_and_link(tmp_path):
    media = resolved(tmp_path)
    assert safe_file(tmp_path, media.directory, media.path.name) == media.path
    with pytest.raises(MediaError):
        safe_file(tmp_path / "another", media.directory, media.path.name)
    link = media.directory / "linked.mkv"
    try:
        link.symlink_to(media.path)
    except OSError:
        return
    with pytest.raises(MediaError):
        safe_file(tmp_path, media.directory, link.name)


async def test_registry_is_idempotent_and_file_replacement_invalidates_identity(media_database):
    factory, media, media_id = media_database
    async with factory() as session:
        first = await resolve_media(session, media_id)
        library = scan_show_library(media.directory, 1)
        await register_library_media(session, 1, library, media.directory)
        assert library.seasons[0].items[0].media_id == media_id
        media.path.write_bytes(b"a new file with a different size")
        with pytest.raises(MediaError) as error:
            ensure_current(first)
        assert error.value.code == "media_changed"
        library = scan_show_library(media.directory, 1)
        await register_library_media(session, 1, library, media.directory)
        replacement_id = library.seasons[0].items[0].media_id
        assert replacement_id != media_id
        with pytest.raises(MediaError) as error:
            await resolve_media(session, media_id)
        assert error.value.code == "media_changed"
        assert (await resolve_media(session, replacement_id)).size != first.size
        assert len(list(await session.scalars(select(MediaFile)))) == 2


def test_probe_tracks_and_hdr_are_explicit(tmp_path):
    media = resolved(tmp_path)
    info = probe.parse_probe(media, probe_json())
    assert info.duration == 120.5 and info.qualities == [720, 1080]
    assert info.audio_tracks[0].id == 1 and info.audio_tracks[0].language == "jpn"
    assert info.subtitle_tracks[0].supported
    assert not info.subtitle_tracks[1].supported and info.subtitle_tracks[1].reason
    hdr = probe.parse_probe(media, probe_json(hdr=True))
    assert hdr.hdr and not hdr.supported and "HDR" in hdr.unsupported_reason
    silent = probe_json()
    silent["streams"] = silent["streams"][:1]
    silent["streams"][0]["height"] = 480
    assert probe.parse_probe(media, silent).audio_tracks == []
    assert probe.parse_probe(media, silent).qualities == [720]


async def test_concurrent_probe_is_shared_and_version_checked(tmp_path, monkeypatch):
    media = resolved(tmp_path)
    probe._cache.clear()
    probe._inflight.clear()
    calls = 0

    async def command(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.01)
        return json.dumps(probe_json()).encode()

    monkeypatch.setattr(probe, "run_media_command", command)
    first, second = await asyncio.gather(probe.probe_media(media), probe.probe_media(media))
    assert calls == 1 and first == second
    await probe.probe_media(media)
    assert calls == 1
    media.path.write_bytes(b"changed")
    with pytest.raises(MediaError) as error:
        await probe.probe_media(media)
    assert error.value.code == "media_changed"


async def test_command_timeout_kills_and_collects_process():
    with pytest.raises(MediaError) as error:
        await probe.run_media_command([sys.executable, "-c", "import time; time.sleep(10)"], 0.05)
    assert error.value.code == "probe_timeout"


def test_media_command_works_on_selector_event_loop():
    loop = asyncio.SelectorEventLoop()
    try:
        output = loop.run_until_complete(probe.run_media_command(
            [sys.executable, "-c", "print('selector-compatible')"], 5,
        ))
        assert output.strip() == b"selector-compatible"
    finally:
        loop.run_until_complete(loop.shutdown_default_executor())
        loop.close()


async def test_cancelled_command_collects_child_process(tmp_path):
    marker = tmp_path / "probe-child.pid"
    code = ("from pathlib import Path; import os,time; "
            f"Path({str(marker)!r}).write_text(str(os.getpid())); time.sleep(10)")
    task = asyncio.create_task(probe.run_media_command([sys.executable, "-c", code], 20))
    async with asyncio.timeout(5):
        while not marker.exists():
            await asyncio.sleep(0.01)
    pid = int(marker.read_text())
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    # Windows Job Object 对 venv 启动器的子解释器终止是异步的；wait 校验实际退出。
    try:
        await asyncio.to_thread(psutil.Process(pid).wait, timeout=2)
    except psutil.NoSuchProcess:
        pass


async def test_external_srt_and_unsupported_subtitle_status(tmp_path, monkeypatch):
    media = resolved(tmp_path)
    probe._cache.clear()
    (media.path.parent / f"{media.path.stem}.zh.srt").write_text(
        "1\n00:00:01,000 --> 00:00:03,000\n字幕\n", encoding="utf-8",
    )
    (media.path.parent / f"{media.path.stem}.ass").write_text("[Script Info]", encoding="utf-8")

    async def command(*_args, **_kwargs):
        return json.dumps(probe_json()).encode()

    monkeypatch.setattr(probe, "run_media_command", command)
    info = await probe.probe_media(media)
    external = [item for item in info.subtitle_tracks if item.id.startswith("e:")]
    assert len(external) == 2
    track = next(item for item in external if item.codec == "srt")
    content = await probe.subtitle_content(media, track.id)
    assert content.startswith("WEBVTT") and "00:00:01.000" in content and "字幕" in content
    unsupported = next(item for item in external if item.codec == "ass")
    with pytest.raises(MediaError) as error:
        await probe.subtitle_content(media, unsupported.id)
    assert error.value.code == "subtitle_unsupported"


async def test_progress_rejects_old_generation_sequence_and_session(media_database):
    factory, _media, media_id = media_database
    started = datetime.now(UTC)

    async def save(session_id, generation, sequence, position, created=started):
        async with factory() as session:
            return await save_progress(session, 1, media_id, ProgressUpdate(
                session_id=session_id, generation=generation, sequence=sequence, position=position,
            ), created, 120)

    assert (await save("first", 1, 2, 40)).position == 40
    assert (await save("first", 1, 1, 20)).position == 40
    assert (await save("first", 2, 0, 60)).position == 60
    assert (await save("first", 1, 99, 10)).position == 60
    assert (await save("second", 1, 0, 90, started + timedelta(seconds=1))).position == 90
    assert (await save("first", 5, 100, 1)).position == 90
    assert (await save("second", 1, 1, 999, started + timedelta(seconds=1))).position == 120


async def test_media_and_subtitles_are_authenticated():
    app = FastAPI()
    app.include_router(router)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test",
    ) as client:
        for path in ["/media/id/playback-info", "/media/id/subtitles/e:123", "/media/id/progress",
                     "/settings/playback/capabilities"]:
            assert (await client.get("/api/v1" + path)).status_code == 401


async def test_library_publishes_media_ids_and_probe_releases_transaction(
    media_database, monkeypatch,
):
    factory, _media, media_id = media_database
    sessions = []
    async with factory() as session:
        await save_progress(session, 1, media_id, ProgressUpdate(
            session_id="test-session", generation=1, sequence=1, position=42,
        ), datetime.now(UTC), 120)

    async def session_override():
        async with factory() as session:
            sessions.append(session)
            yield session

    async def probe_override(media):
        assert all(not session.in_transaction() for session in sessions)
        return probe.parse_probe(media, probe_json())

    monkeypatch.setattr("app.playback.router.probe_media", probe_override)
    app = FastAPI()
    app.include_router(api_router)
    app.include_router(router)
    app.dependency_overrides[get_session] = session_override
    app.dependency_overrides[require_user] = lambda: User(id=1, username="admin", password_hash="x")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test",
    ) as client:
        library = await client.get("/api/v1/shows/1/library")
        assert library.status_code == 200
        assert library.json()["seasons"][0]["items"][0]["media_id"] == media_id
        assert library.json()["seasons"][0]["items"][0]["progress"]["position"] == 42
        info = await client.get(f"/api/v1/media/{media_id}/playback-info")
        assert info.status_code == 200
        assert info.headers["cache-control"] == "no-store"
        assert info.json()["video_width"] == 1920
        assert info.json()["progress"]["position"] == 42


async def test_probe_cancellation_does_not_cancel_shared_work(tmp_path, monkeypatch):
    media = resolved(tmp_path)
    probe._cache.clear()
    finished = asyncio.Event()

    async def command(*_args, **_kwargs):
        await finished.wait()
        return json.dumps(probe_json()).encode()

    monkeypatch.setattr(probe, "run_media_command", command)
    first = asyncio.create_task(probe.probe_media(media))
    while media.media_id not in probe._inflight:
        await asyncio.sleep(0)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    second = asyncio.create_task(probe.probe_media(media))
    finished.set()
    assert (await second).duration == 120.5
    assert media.media_id not in probe._inflight


async def test_command_output_is_bounded():
    with pytest.raises(MediaError) as error:
        await probe.run_media_command(
            [sys.executable, "-c", "print('x' * 65536)"], 5, max_bytes=1024,
        )
    assert error.value.code == "probe_output_limit"


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"),
                    reason="没有安装 FFmpeg/FFprobe")
async def test_real_ffmpeg_probe_silent_sdr(tmp_path):
    path = tmp_path / "sample.mp4"
    await probe.run_media_command([
        "ffmpeg", "-v", "error", "-nostdin", "-f", "lavfi", "-i",
        "color=size=128x72:rate=24", "-t", "1", "-c:v", "libx264", "-pix_fmt",
        "yuv420p", str(path),
    ], 10)
    info = path.stat()
    version = file_version(path.name, info.st_size, info.st_mtime_ns)
    media = ResolvedMedia("b" * 64, 1, path, version, info.st_size, info.st_mtime_ns,
                          tmp_path, tmp_path, path.name)
    result = await probe.probe_media(media)
    assert result.duration == 1 and result.video_width == 128 and result.video_height == 72
    assert result.supported and not result.hdr and not result.audio_tracks


@pytest.mark.parametrize("state,plan,blocked", [
    ("moving", None, True),
    ("replacing", {}, True),
    ("needs_review", {"season_change": {"phase": "rename"}}, True),
    ("needs_review", {"replacement": {"phase": "backup"}}, True),
    ("upgrading", {"replacement": {"phase": "downloading"}}, False),
    ("needs_review", {"replacement": {"phase": "rolled_back"}}, False),
    ("done", {"replacement": {"phase": "done"}}, False),
])
async def test_persisted_pending_migrations_block_playback_after_restart(
    media_database, state, plan, blocked,
):
    factory, _media, media_id = media_database
    async with factory() as session:
        item = FeedItem(source_id=1, title="episode", fingerprint="test", parse_data="{}")
        session.add(item)
        await session.flush()
        session.add(DownloadJob(item_id=item.id, info_hash="a" * 40, downloader_id=1,
                                target_root="unused", title="作品", season=1, state=state,
                                plan=json.dumps(plan) if plan is not None else None))
        await session.commit()
        if blocked:
            with pytest.raises(MediaError) as error:
                await resolve_media(session, media_id)
            assert error.value.code == "media_migrating"
        else:
            assert (await resolve_media(session, media_id)).media_id == media_id


async def test_deleting_source_releases_pending_mutation(media_database):
    from app.api import delete_feed
    from app.playback.leases import begin_mutation, ensure_source_available

    factory, _media, _media_id = media_database
    assert begin_mutation(1)
    async with factory() as session:
        await delete_feed(1, _user=User(id=1), session=session)
    ensure_source_available(1)


async def test_active_session_saves_progress_while_migration_waits(media_database, monkeypatch):
    from app.playback.leases import begin_mutation, finish_mutation
    from app.playback.sessions import PlaybackSession, SessionManager

    factory, media, media_id = media_database
    info = probe.parse_probe(media, probe_json())
    info.media_id = media_id
    manager = SessionManager()
    # 使用真实会话归属和代次校验；文件路径已移动，进度只依赖建立时的会话信息。
    async with factory() as database:
        current = await resolve_media(database, media_id)
    playing = PlaybackSession("playing", 1, current, info, media.path.parent / "unused-cache",
                               42, 720, None, generation=2, status="paused")
    manager.sessions[playing.id] = playing
    monkeypatch.setattr("app.playback.sessions.manager", manager)
    media.path.rename(media.path.with_name("moved.mkv"))
    assert begin_mutation(1)

    async def session_override():
        async with factory() as database:
            yield database

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_session] = session_override
    app.dependency_overrides[require_user] = lambda: User(id=1)
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test",
        ) as client:
            response = await client.put(f"/api/v1/media/{media_id}/progress", json={
                "session_id": "playing", "generation": 2, "sequence": 1, "position": 42,
            })
            assert response.status_code == 200 and response.json()["position"] == 42
            stale = await client.put(f"/api/v1/media/{media_id}/progress", json={
                "session_id": "playing", "generation": 1, "sequence": 99, "position": 1,
            })
            assert stale.status_code == 409
            stored = await client.get(f"/api/v1/media/{media_id}/progress")
            assert stored.json()["position"] == 42
    finally:
        finish_mutation(1)
