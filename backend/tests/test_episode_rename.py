import json
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs

import httpx
import pytest
from sqlalchemy import select

from app import download_queue
from app.dependencies import require_user
from app.library_scan import scan_source
from app.models import (
    DomainEvent,
    DownloaderConfig,
    DownloadJob,
    EpisodeThumbnail,
    FeedItem,
    FeedSource,
    LibrarySettings,
    PlaybackProgress,
    ShowArtwork,
    User,
)
from app.playback import leases
from app.playback.media import MediaError, resolve_media

HASH = "a" * 40
OLD = "Season 01/番名 S01E01.mkv"
NEW = "Season 01/番名 S01E01 修正版.mkv"


class RenameQB:
    def __init__(self, directory):
        self.directory = directory
        self.torrent = {"hash": HASH, "save_path": "/media/番名", "state": "uploading"}
        self.files = [{"index": 0, "name": OLD, "progress": 1, "size": 5}]
        self.calls = []
        self.delayed = False
        self.lose_response = False
        self.reject = False
        self.login_ok = True
        self.pending = None

    def finish(self):
        old, new = self.pending
        source, target = self.directory / old, self.directory / new
        assert source.is_relative_to(self.directory) and target.is_relative_to(self.directory)
        source.rename(target)
        self.files[0]["name"] = new
        self.pending = None

    def handle(self, request):
        endpoint = request.url.path.rsplit("/", 1)[-1]
        data = {key: value[0] for key, value in parse_qs(request.content.decode()).items()}
        self.calls.append((endpoint, data))
        if endpoint == "login":
            return httpx.Response(200, text="Ok." if self.login_ok else "Fails.")
        if endpoint == "info":
            return httpx.Response(200, json=[deepcopy(self.torrent)])
        if endpoint == "files":
            return httpx.Response(200, json=deepcopy(self.files))
        assert endpoint == "renameFile", f"不应调用其他写入 API：{endpoint}"
        assert data["hash"] == HASH
        assert data["oldPath"] == self.files[0]["name"]
        if self.reject:
            return httpx.Response(409)
        self.pending = data["oldPath"], data["newPath"]
        if not self.delayed:
            self.finish()
        if self.lose_response:
            self.lose_response = False
            raise httpx.ReadTimeout("模拟成功后响应丢失", request=request)
        return httpx.Response(200)


@pytest.fixture
async def rename_env(show_client, monkeypatch, tmp_path):
    api, sessions, app = show_client
    library = tmp_path / "library"
    directory = library / "番名"
    (directory / "Season 01").mkdir(parents=True)
    (directory / OLD).write_bytes(b"video")
    (directory / "Season 01/episode-thumb.jpg").write_bytes(b"image")
    async with sessions() as session:
        source = await session.get(FeedSource, 1)
        source.name, source.season = "番名", 1
        session.add_all([
            User(id=1, username="admin", password_hash="test"),
            LibrarySettings(id=1, library_root=str(library)),
            ShowArtwork(source_id=1, directory=str(directory)),
            EpisodeThumbnail(source_id=1, video_path=OLD,
                             image_path="Season 01/episode-thumb.jpg", file_version="v1"),
            DownloaderConfig(id=1, name="qB", kind="qbittorrent", base_url="http://qb.rename",
                             local_download_root=str(library), remote_download_root="/media"),
            FeedItem(id=1, source_id=1, title="番名 S01E01", fingerprint="test", parse_data="{}"),
        ])
        await session.flush()
        session.add(DownloadJob(id=1, item_id=1, info_hash=HASH, downloader_id=1, state="done",
                                target_root="/media", title="番名", season=1,
                                plan=json.dumps({"files": [{"old": "video.mkv", "new": OLD}]})))
        await session.commit()
    app.dependency_overrides[require_user] = lambda: User(id=1, username="admin")
    episode = (await api.get("/api/v1/shows/1/library")).json()["seasons"][0]["items"][0]
    async with sessions() as session:
        session.add(PlaybackProgress(
            user_id=1, media_id=episode["media_id"], position=123, duration=1440,
            completed=False, session_id="old-session", session_created_at=datetime.now(UTC),
            generation=1, sequence=1,
        ))
        await session.commit()
    fake = RenameQB(directory)
    original = httpx.AsyncClient

    def client(*args, **kwargs):
        if kwargs.get("base_url") == "http://qb.rename":
            kwargs["transport"] = httpx.MockTransport(fake.handle)
        return original(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", client)
    monkeypatch.setattr(download_queue, "SessionFactory", sessions)
    monkeypatch.setattr("app.library_scan.SessionFactory", sessions)
    yield api, sessions, app, fake, episode
    leases.finish_mutation(1)


async def rename(api, episode, filename="番名 S01E01 修正版.mkv"):
    return await api.post("/api/v1/shows/1/episodes/rename", json={
        "media_id": episode["media_id"], "filename": filename,
    })


async def test_rename_uses_qb_file_api_and_preserves_playback(rename_env):
    api, sessions, _, fake, episode = rename_env
    response = await rename(api, episode)
    assert response.status_code == 200, response.text
    assert response.json()["pending"] is False
    writes = [(endpoint, data) for endpoint, data in fake.calls if endpoint == "renameFile"]
    assert writes == [("renameFile", {"hash": HASH, "oldPath": OLD, "newPath": NEW})]
    assert not (fake.directory / OLD).exists() and (fake.directory / NEW).exists()
    updated = (await api.get("/api/v1/shows/1/library")).json()["seasons"][0]["items"][0]
    assert updated["path"] == NEW and updated["media_id"] != episode["media_id"]
    assert updated["progress"]["position"] == 123
    assert updated["thumbnail_url"]
    async with sessions() as session:
        job = await session.get(DownloadJob, 1)
        assert job.state == "done" and json.loads(job.plan)["files"][0]["new"] == NEW
        assert (await session.scalar(select(EpisodeThumbnail))).video_path == NEW
        assert (await session.scalar(select(DomainEvent))).event_type == "download.episode.renamed"
        with pytest.raises(MediaError):
            await resolve_media(session, episode["media_id"])
        assert (await resolve_media(session, updated["media_id"])).path.name.endswith("修正版.mkv")
    await scan_source(1)
    async with sessions() as session:
        assert (await session.scalar(select(EpisodeThumbnail))).video_path == NEW


@pytest.mark.parametrize("lost_response", [False, True])
async def test_async_rename_is_recoverable_and_blocks_playback(rename_env, lost_response):
    api, sessions, _, fake, episode = rename_env
    fake.delayed, fake.lose_response = not lost_response, lost_response
    response = await rename(api, episode)
    assert response.status_code == 202 and response.json()["pending"]
    async with sessions() as session:
        job = await session.get(DownloadJob, 1)
        assert json.loads(job.plan)["episode_rename"]["new"] == NEW
        with pytest.raises(MediaError, match="迁移"):
            await resolve_media(session, episode["media_id"])
        # 停用 RSS 也应继续完成用户已提交的改名。
        (await session.get(FeedSource, 1)).active = False
        await session.commit()
    listing = (await api.get("/api/v1/shows/1/library")).json()
    assert listing["seasons"][0]["items"][0]["rename_pending"]
    if fake.delayed:
        fake.finish()
    # 使用新的数据库会话推进，模拟请求结束或服务重启后恢复。
    await download_queue.process_queue()
    async with sessions() as session:
        job = await session.get(DownloadJob, 1)
        assert job.state == "done" and "episode_rename" not in json.loads(job.plan)
    assert len([call for call in fake.calls if call[0] == "renameFile"]) == 1
    updated = (await api.get("/api/v1/shows/1/library")).json()["seasons"][0]["items"][0]
    assert updated["progress"]["position"] == 123


async def test_renaming_back_keeps_the_latest_watch_progress(rename_env):
    api, sessions, _, _, episode = rename_env
    assert (await rename(api, episode)).status_code == 200
    updated = (await api.get("/api/v1/shows/1/library")).json()["seasons"][0]["items"][0]
    async with sessions() as session:
        progress = await session.get(PlaybackProgress, (1, updated["media_id"]))
        progress.position, progress.updated_at = 456, datetime.now(UTC) + timedelta(seconds=1)
        await session.commit()
    assert (await rename(api, updated, "番名 S01E01.mkv")).status_code == 200
    restored = (await api.get("/api/v1/shows/1/library")).json()["seasons"][0]["items"][0]
    assert restored["media_id"] == episode["media_id"]
    assert restored["progress"]["position"] == 456


@pytest.mark.parametrize("filename", [
    "../escape.mkv", "x/y.mkv", "x\\y.mkv", "x:bad.mkv", "CON.mkv", "x?.mkv",
    ".hidden.mkv", "new.mp4", "x.mkv ", "x\nm.mkv", "番名 S01E01.mkv", "长" * 90 + ".mkv",
])
async def test_invalid_names_do_not_contact_qb(rename_env, filename):
    api, _, _, fake, episode = rename_env
    response = await rename(api, episode, filename)
    assert response.status_code == 422, response.text
    assert not fake.calls
    assert (fake.directory / OLD).exists()


async def test_conflicts_and_playing_files_are_not_renamed(rename_env):
    api, _, _, fake, episode = rename_env
    (fake.directory / NEW).write_bytes(b"existing")
    assert (await rename(api, episode)).status_code == 409
    assert not fake.calls and (fake.directory / NEW).read_bytes() == b"existing"
    leases.acquire_source(1)
    try:
        assert (await rename(api, episode, "other.mkv")).status_code == 409
    finally:
        leases.release_source(1)
    assert not fake.calls


async def test_auth_source_and_mapping_checks(rename_env):
    api, sessions, app, fake, episode = rename_env
    body = {"media_id": episode["media_id"], "filename": "new.mkv"}
    assert (await api.post("/api/v1/shows/2/episodes/rename", json=body)).status_code == 404
    app.dependency_overrides.pop(require_user)
    assert (await rename(api, episode)).status_code == 401
    app.dependency_overrides[require_user] = lambda: object()
    fake.torrent["save_path"] = "/other"
    assert (await rename(api, episode)).status_code == 409
    assert not any(call[0] == "renameFile" for call in fake.calls)
    async with sessions() as session:
        assert (await session.get(DownloadJob, 1)).state == "done"


async def test_qb_rejection_keeps_original_plan(rename_env):
    api, sessions, _, fake, episode = rename_env
    fake.reject = True
    response = await rename(api, episode)
    assert response.status_code == 409
    async with sessions() as session:
        job = await session.get(DownloadJob, 1)
        assert job.state == "done" and "episode_rename" not in json.loads(job.plan)
        assert json.loads(job.plan)["files"][0]["new"] == OLD
    assert (fake.directory / OLD).exists()


async def test_unfinished_files_and_bad_login_are_rejected(rename_env):
    api, _, _, fake, episode = rename_env
    fake.files[0]["progress"] = .5
    assert (await rename(api, episode)).status_code == 409
    fake.files[0]["progress"] = 1
    fake.login_ok = False
    assert (await rename(api, episode)).status_code == 502
    assert not any(call[0] == "renameFile" for call in fake.calls)


async def test_pending_rename_preserves_thumbnail_and_blocks_other_migrations(rename_env):
    api, sessions, _, fake, episode = rename_env
    fake.delayed = True
    assert (await rename(api, episode)).status_code == 202
    assert await scan_source(1) == (False, 0)
    from app.season_change import schedule_season_change

    async with sessions() as session:
        source = await session.get(FeedSource, 1)
        with pytest.raises(ValueError, match="改名"):
            await schedule_season_change(session, source, 2)
        assert (await session.scalar(select(EpisodeThumbnail))).video_path == OLD
