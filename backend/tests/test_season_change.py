import json
from copy import deepcopy
from pathlib import Path
from urllib.parse import parse_qs

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import download_queue
from app.api import router
from app.database import Base, get_session
from app.dependencies import require_user
from app.models import (
    DomainEvent,
    DownloaderConfig,
    DownloadJob,
    FeedItem,
    FeedSource,
    ShowArtwork,
)
from app.release_parser import parse_release_title

HASH = "a" * 40
OTHER_HASH = "b" * 40


class FakeQB:
    """实际移动独立测试目录内的文件，模拟异步 API 成功后响应丢失。"""

    def __init__(self, root):
        self.root = root
        self.torrents = {}
        self.files = {}
        self.calls = []
        self.fail_after = None
        self.failed = False

    def path(self, info_hash, name):
        path = Path(self.torrents[info_hash]["save_path"]) / name
        assert path.resolve().is_relative_to(self.root.resolve())
        return path

    def handle(self, request):
        endpoint = request.url.path.rsplit("/", 1)[-1]
        data = {key: values[0] for key, values in parse_qs(request.content.decode()).items()}
        info_hash = (data.get("hashes") or data.get("hash")
                     or request.url.params.get("hashes"))
        self.calls.append((endpoint, data))
        if endpoint == "login":
            return httpx.Response(200, text="Ok.")
        if endpoint == "info":
            values = ([self.torrents[info_hash]] if info_hash in self.torrents else []) \
                if info_hash else list(self.torrents.values())
            return httpx.Response(200, json=deepcopy(values))
        if endpoint == "files":
            return httpx.Response(200, json=deepcopy(self.files[request.url.params["hash"]]))
        if endpoint == "add":
            return httpx.Response(500)
        if endpoint in {"stop", "start"}:
            self.torrents[info_hash]["state"] = "stoppedUP" if endpoint == "stop" else "uploading"
        if endpoint == "setLocation":
            paths = [(file["name"], self.path(info_hash, file["name"]))
                     for file in self.files[info_hash]]
            self.torrents[info_hash]["save_path"] = data["location"]
            for name, old in paths:
                target = self.path(info_hash, name)
                assert not target.exists()
                target.parent.mkdir(parents=True, exist_ok=True)
                old.replace(target)
        if endpoint == "renameFile":
            file = next(file for file in self.files[info_hash] if file["name"] == data["oldPath"])
            old = self.path(info_hash, file["name"])
            target = self.path(info_hash, data["newPath"])
            assert not target.exists()
            target.parent.mkdir(parents=True, exist_ok=True)
            old.replace(target)
            file["name"] = data["newPath"]
        if endpoint in {"addTags", "removeTags"}:
            tags = set(self.torrents[info_hash].get("tags", "").split(", ")) - {""}
            assert data["tags"] and "," not in data["tags"]
            if endpoint == "addTags":
                tags.add(data["tags"])
            else:
                tags.discard(data["tags"])
            self.torrents[info_hash]["tags"] = ", ".join(sorted(tags))
        assert endpoint not in {"delete", "rename", "renameFolder", "filePrio"}
        if endpoint == self.fail_after and not self.failed:
            self.failed = True
            return httpx.Response(500)
        return httpx.Response(200)


@pytest.fixture
async def season_app(monkeypatch, tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'app.db'}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(download_queue, "SessionFactory", sessions)
    fake = FakeQB(tmp_path)
    original_client = httpx.AsyncClient

    def client(*args, **kwargs):
        if kwargs.get("base_url") == "http://qb.test":
            kwargs["transport"] = httpx.MockTransport(fake.handle)
        return original_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", client)
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[require_user] = lambda: object()

    async def get_test_session():
        async with sessions() as session:
            yield session

    app.dependency_overrides[get_session] = get_test_session
    async with original_client(transport=httpx.ASGITransport(app), base_url="http://test") as api:
        yield api, sessions, fake, tmp_path
    await engine.dispose()


async def seed(sessions, fake, root, *, wrapper=False, multi=False, running=True,
               active=True, state="done", raw_season=1):
    release = parse_release_title(f"[Group] Example S{raw_season:02d}E05 [1080p]")
    release.evidence.append("manual_review")
    release.episode_start = 5.5
    prefix = "Season 01/" if wrapper else ""
    names = [prefix + "番名 S01E05.5.mkv", prefix + "番名 S01E05.5.chs.ass"]
    if multi:
        names.append(prefix + "番名 S01E06.mp4")
    skipped = prefix + "Example - 05 [CHT].mkv"
    plan = {"wrapper": "Pack" if wrapper else None, "season_folder": "Season 01",
            "files": [{"old": name, "new": name} for name in names],
            "skip_file_ids": [len(names)], "selection_version": 2, "show_tag": "番名"}
    location = root / "library" / "番名"
    if not wrapper:
        location /= "Season 01"
    if state == "metadata":
        location = root / "library" / ".mooncell" / HASH
        names = ["video.mkv"]
        skipped = "video [CHT].mkv"
        plan = None
    fake.torrents[HASH] = {"hash": HASH, "name": "原始种子名称", "save_path": str(location),
                           "state": "uploading" if running else "stoppedUP",
                           "auto_tmm": False, "progress": 1, "amount_left": 0,
                           "tags": "手动收藏, 保留标签"}
    fake.files[HASH] = [{"index": index, "name": name, "priority": 1, "progress": 1}
                        for index, name in enumerate(names)]
    fake.files[HASH].append({"index": len(names), "name": skipped, "priority": 0, "progress": 0})
    for file in fake.files[HASH]:
        path = fake.path(HASH, file["name"])
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"content-{file['index']}", encoding="utf-8")
    async with sessions() as session:
        session.add_all([
            FeedSource(id=1, name="番名", season=1, url="https://example.test/rss", active=active),
            DownloaderConfig(id=1, name="qB", kind="qbittorrent", base_url="http://qb.test"),
        ])
        await session.flush()
        session.add(FeedItem(id=1, source_id=1, title=release.raw_title, fingerprint="first",
                             info_hash=HASH, download_url=f"magnet:?xt=urn:btih:{HASH}",
                             parse_data=release.model_dump_json()))
        await session.flush()
        session.add(DownloadJob(id=1, item_id=1, info_hash=HASH, downloader_id=1,
                                target_root=str(root / "library"), title="番名", season=1,
                                state=state, plan=json.dumps(plan) if plan else None))
        await session.commit()
    return location, plan


async def finish(sessions, iterations=35):
    # 每轮重新创建会话，从数据库恢复阶段，模拟中断后继续。
    for _ in range(iterations):
        await download_queue.process_queue()
        async with sessions() as session:
            job = await session.get(DownloadJob, 1)
            if job.state == "done":
                return job
    pytest.fail(f"migration did not complete: {job.last_error}; {job.plan}")


@pytest.mark.parametrize("wrapper", [False, True])
@pytest.mark.parametrize("multi", [False, True])
@pytest.mark.parametrize("running", [False, True])
@pytest.mark.parametrize("failure", [None, "setLocation", "renameFile", "addTags"])
async def test_migrate_files_tags_paths_and_db_preserving_episodes(
    season_app, wrapper, multi, running, failure,
):
    api, sessions, fake, root = season_app
    await seed(sessions, fake, root, wrapper=wrapper, multi=multi, running=running)
    fake.fail_after = failure
    response = await api.patch("/api/v1/feeds/1", json={"season": 2})
    assert response.status_code == 200
    assert not fake.calls  # HTTP 请求只持久化，不长时间等待下载器。
    async with sessions() as session:
        item = await session.get(FeedItem, 1)
        data = json.loads(item.parse_data)
        assert (data["season"], data["episode_start"]) == (2, 5.5)
        assert "manual_review" in data["evidence"]
    result = await finish(sessions)
    assert result.season == 2
    assert not (root / "library" / ".mooncell").exists()
    assert "season_change" not in json.loads(result.plan)
    torrent = fake.torrents[HASH]
    assert torrent["hash"] == HASH
    assert torrent["state"] == ("uploading" if running else "stoppedUP")
    expected_location = root / "library" / "番名"
    if not wrapper:
        expected_location /= "Season 02"
    assert torrent["save_path"] == str(expected_location)
    assert torrent["name"] == "原始种子名称"
    assert set(torrent["tags"].split(", ")) == {"手动收藏", "保留标签", "番名"}
    assert json.loads(result.plan)["show_tag"] == "番名"
    if failure:
        assert fake.failed
    prefix = "Season 02/" if wrapper else ""
    assert fake.files[HASH][0]["name"] == prefix + "番名 S02E05.5.mkv"
    assert fake.files[HASH][1]["name"] == prefix + "番名 S02E05.5.chs.ass"
    if multi:
        assert fake.files[HASH][2]["name"] == prefix + "番名 S02E06.mp4"
    assert fake.files[HASH][-1]["priority"] == 0
    for file in fake.files[HASH]:
        assert fake.path(HASH, file["name"]).read_text(encoding="utf-8") == (
            f"content-{file['index']}"
        )
    assert not any(endpoint == "add" for endpoint, _ in fake.calls)
    async with sessions() as session:
        assert await session.scalar(select(DomainEvent).where(
            DomainEvent.event_type == "download.library.changed",
        )) is not None


@pytest.mark.parametrize("kind", ["local", "other_torrent", "shared_source", "manual_path"])
async def test_conflicts_never_overwrite_or_move_shared_files(
    season_app, kind,
):
    api, sessions, fake, root = season_app
    original, _ = await seed(sessions, fake, root)
    conflict = root / "library" / "番名" / "Season 02" / "番名 S02E05.5.mkv"
    if kind == "local":
        conflict.parent.mkdir(parents=True, exist_ok=True)
        conflict.write_text("other-content", encoding="utf-8")
    elif kind in {"other_torrent", "shared_source"}:
        fake.torrents[OTHER_HASH] = {"hash": OTHER_HASH, "save_path": str(
            conflict.parent if kind == "other_torrent" else original
        )}
        fake.files[OTHER_HASH] = [{"name": conflict.name if kind == "other_torrent"
                                   else fake.files[HASH][0]["name"], "priority": 1}]
    else:
        fake.torrents[HASH]["save_path"] = str(root / "manually-changed")
    assert (await api.patch("/api/v1/feeds/1", json={"season": 2})).status_code == 200
    await download_queue.process_queue()
    assert not any(endpoint in {"stop", "setLocation", "renameFile", "rename"}
                   for endpoint, _ in fake.calls)
    assert (original / "番名 S01E05.5.mkv").read_text(encoding="utf-8") == "content-0"
    if kind == "local":
        assert conflict.read_text(encoding="utf-8") == "other-content"
    async with sessions() as session:
        assert (await session.get(DownloadJob, 1)).last_error


async def test_paused_subscription_migrates_existing_files_and_missing_torrent_is_not_readded(
    season_app,
):
    api, sessions, fake, root = season_app
    await seed(sessions, fake, root, active=False)
    assert (await api.patch("/api/v1/feeds/1", json={"season": 0})).status_code == 200
    assert (await finish(sessions)).season == 0
    assert fake.torrents[HASH]["name"] == "原始种子名称"
    assert (await api.patch("/api/v1/feeds/1", json={"season": 3})).status_code == 200
    del fake.torrents[HASH]
    await download_queue.process_queue()
    assert not any(endpoint == "add" for endpoint, _ in fake.calls)
    async with sessions() as session:
        assert "不会重新下载" in (await session.get(DownloadJob, 1)).last_error


async def test_clear_season_reads_original_title_but_preserves_manual_episode(
    season_app,
):
    api, sessions, fake, root = season_app
    await seed(sessions, fake, root, raw_season=3)
    assert (await api.patch("/api/v1/feeds/1", json={"season": None})).status_code == 200
    result = await finish(sessions)
    assert result.season == 3
    assert fake.torrents[HASH]["name"] == "原始种子名称"
    async with sessions() as session:
        assert (await session.get(FeedSource, 1)).season is None
        assert json.loads((await session.get(FeedItem, 1)).parse_data)["episode_start"] == 5.5


async def test_inflight_revision_and_second_migration_are_rejected_without_partial_changes(
    season_app,
):
    api, sessions, fake, root = season_app
    await seed(sessions, fake, root)
    async with sessions() as session:
        job = await session.get(DownloadJob, 1)
        job.state = "upgrading"
        await session.commit()
    response = await api.patch("/api/v1/feeds/1", json={"name": "新名字", "season": 2})
    assert response.status_code == 409
    async with sessions() as session:
        source = await session.get(FeedSource, 1)
        assert (source.name, source.season) == ("番名", 1)
        job = await session.get(DownloadJob, 1)
        job.state = "done"
        await session.commit()
    assert (await api.patch("/api/v1/feeds/1", json={"season": 2})).status_code == 200
    assert (await api.patch("/api/v1/feeds/1", json={"season": 3})).status_code == 409
    assert (await api.patch("/api/v1/feeds/1", json={"season": 2})).status_code == 200
    async with sessions() as session:
        assert (await session.get(FeedSource, 1)).season == 2


async def test_metadata_task_uses_new_season_without_changing_episode(
    season_app,
):
    api, sessions, fake, root = season_app
    await seed(sessions, fake, root, state="metadata", running=False)
    assert (await api.patch("/api/v1/feeds/1", json={"season": 2})).status_code == 200
    await finish(sessions)
    assert fake.files[HASH][0]["name"] == "番名 S02E5.5.mkv"
    assert fake.files[HASH][-1]["priority"] == 0
    assert fake.torrents[HASH]["state"] == "uploading"
    assert not (root / "library" / ".mooncell").exists()


async def test_target_conflict_after_staging_keeps_files_and_can_resume(
    season_app,
):
    api, sessions, fake, root = season_app
    await seed(sessions, fake, root)
    assert (await api.patch("/api/v1/feeds/1", json={"season": 2})).status_code == 200
    for _ in range(20):
        await download_queue.process_queue()
        async with sessions() as session:
            phase = json.loads((await session.get(DownloadJob, 1)).plan)["season_change"]["phase"]
        if phase == "move":
            break
    assert phase == "move"
    conflict = root / "library" / "番名" / "Season 02" / "番名 S02E05.5.mkv"
    conflict.parent.mkdir(parents=True, exist_ok=True)
    conflict.write_text("occupied", encoding="utf-8")
    await download_queue.process_queue()
    assert conflict.read_text(encoding="utf-8") == "occupied"
    assert "season-change" in fake.torrents[HASH]["save_path"]
    assert fake.torrents[HASH]["state"] == "stoppedUP"
    assert fake.path(HASH, fake.files[HASH][0]["name"]).read_text(encoding="utf-8") == "content-0"
    conflict.unlink()
    await finish(sessions)
    assert conflict.read_text(encoding="utf-8") == "content-0"


async def test_second_migration_and_other_episode_in_shared_season_directory(
    season_app,
):
    api, sessions, fake, root = season_app
    original, _ = await seed(sessions, fake, root, wrapper=True)
    other_name = "Season 01/番名 S01E09.mkv"
    fake.torrents[OTHER_HASH] = {"hash": OTHER_HASH, "save_path": str(original)}
    fake.files[OTHER_HASH] = [{"name": other_name, "priority": 1}]
    other_file = fake.path(OTHER_HASH, other_name)
    other_file.write_text("untouched", encoding="utf-8")
    for season in (2, 3):
        assert (await api.patch("/api/v1/feeds/1", json={"season": season})).status_code == 200
        await finish(sessions)
        assert fake.files[HASH][0]["name"] == f"Season {season:02d}/番名 S{season:02d}E05.5.mkv"
        assert fake.files[HASH][-1]["name"].startswith(f"Season {season:02d}/")
        assert fake.files[HASH][-1]["priority"] == 0
        assert other_file.read_text(encoding="utf-8") == "untouched"


@pytest.mark.parametrize("wrapper", [False, True])
@pytest.mark.parametrize("new_season", [None, 2])
@pytest.mark.parametrize("failure", [None, "setLocation", "renameFile", "addTags", "removeTags"])
async def test_name_is_applied_before_season_and_old_paths_remain_recoverable(
    season_app, wrapper, new_season, failure,
):
    api, sessions, fake, root = season_app
    original, _ = await seed(sessions, fake, root, wrapper=wrapper, multi=True, running=False)
    fake.torrents[HASH]["tags"] += ", 番名"
    fake.fail_after = failure
    # 新番名目录已存在，也必须按旧番名快照定位原文件。
    new_root = root / "library" / "新番名"
    new_root.mkdir()
    (new_root / "unrelated.txt").write_text("leave-alone", encoding="utf-8")
    payload = {"season": new_season, "name": "新番名"} if new_season else {"name": "新番名"}
    assert (await api.patch("/api/v1/feeds/1", json=payload)).status_code == 200
    target_season = new_season or 1
    async with sessions() as session:
        job = await session.get(DownloadJob, 1)
        assert (job.title, job.season) == ("新番名", target_season)
        pending = json.loads(job.plan)["season_change"]
        assert (pending["previous_title"], pending["previous_season"]) == ("番名", 1)
        parsed = json.loads((await session.get(FeedItem, 1)).parse_data)
        assert (parsed["title"], parsed["episode_start"]) == ("新番名", 5.5)
    result = await finish(sessions)
    expected_location = new_root if wrapper else new_root / f"Season {target_season:02d}"
    assert fake.torrents[HASH]["save_path"] == str(expected_location)
    assert fake.torrents[HASH]["name"] == "原始种子名称"
    assert set(fake.torrents[HASH]["tags"].split(", ")) == {"手动收藏", "保留标签", "新番名"}
    assert json.loads(result.plan)["show_tag"] == "新番名"
    if failure:
        assert fake.failed
    prefix = f"Season {target_season:02d}/" if wrapper else ""
    assert fake.files[HASH][0]["name"] == prefix + f"新番名 S{target_season:02d}E05.5.mkv"
    assert fake.files[HASH][1]["name"] == prefix + f"新番名 S{target_season:02d}E05.5.chs.ass"
    assert fake.files[HASH][2]["name"] == prefix + f"新番名 S{target_season:02d}E06.mp4"
    assert fake.torrents[HASH]["state"] == "stoppedUP"
    assert result.title == "新番名"
    for file in fake.files[HASH]:
        assert fake.path(HASH, file["name"]).read_text(encoding="utf-8") == (
            f"content-{file['index']}"
        )
    assert not (original / ("Season 01/" if wrapper else "") / "番名 S01E05.5.mkv").exists()
    assert (new_root / "unrelated.txt").read_text(encoding="utf-8") == "leave-alone"


async def add_artwork(sessions, root):
    directory = root / "library" / "番名"
    directory.mkdir(parents=True, exist_ok=True)
    paths = {}
    for name in ("poster.jpg", "fanart.jpg", "clearlogo.png"):
        path = directory / name
        path.write_bytes(name.encode())
        paths[name.split(".")[0] + "_path"] = str(path)
    async with sessions() as session:
        session.add(ShowArtwork(source_id=1, directory=str(directory), **paths))
        await session.commit()
    return directory, paths


async def test_name_and_season_preserve_shared_artwork_and_migrate_media(season_app):
    api, sessions, fake, root = season_app
    await seed(sessions, fake, root)
    directory, paths = await add_artwork(sessions, root)
    async with sessions() as session:
        session.add(FeedSource(id=2, name="其他订阅", url="https://example.test/other"))
        await session.flush()
        session.add(ShowArtwork(source_id=2, directory=str(directory), **paths))
        await session.commit()
    response = await api.patch("/api/v1/feeds/1", json={"name": "新番名", "season": 2})
    assert response.status_code == 200
    async with sessions() as session:
        artwork = (await session.get(FeedSource, 1)).artwork
        assert artwork.directory == str(root / "library" / "新番名")
        for field, old in paths.items():
            assert Path(getattr(artwork, field)).read_bytes() == Path(old).read_bytes()
        shared = (await session.get(FeedSource, 2)).artwork
        assert shared.directory == str(directory)
        assert shared.poster_path == paths["poster_path"]
    await finish(sessions)
    assert fake.torrents[HASH]["name"] == "原始种子名称"
    assert all(Path(path).exists() for path in paths.values())


async def test_artwork_conflict_rejects_entire_edit_without_overwriting(season_app):
    api, sessions, fake, root = season_app
    original, _ = await seed(sessions, fake, root)
    _, paths = await add_artwork(sessions, root)
    conflict = root / "library" / "新番名" / "poster.jpg"
    conflict.parent.mkdir()
    conflict.write_bytes(b"another-poster")
    response = await api.patch("/api/v1/feeds/1", json={"season": 2, "name": "新番名"})
    assert response.status_code == 409
    assert conflict.read_bytes() == b"another-poster"
    assert not fake.calls
    async with sessions() as session:
        source = await session.get(FeedSource, 1)
        job = await session.get(DownloadJob, 1)
        assert (source.name, source.season) == ("番名", 1)
        assert (job.title, job.season, job.state) == ("番名", 1, "done")
        assert source.artwork.poster_path == paths["poster_path"]
    assert (original / "番名 S01E05.5.mkv").is_file()


async def test_name_only_with_automatic_season_and_repeated_name_edit(season_app):
    api, sessions, fake, root = season_app
    await seed(sessions, fake, root)
    async with sessions() as session:
        source = await session.get(FeedSource, 1)
        source.season = None
        await session.commit()
    payload = {"name": "新番名", "season": None}
    assert (await api.patch("/api/v1/feeds/1", json=payload)).status_code == 200
    assert (await api.patch("/api/v1/feeds/1", json=payload)).status_code == 200
    assert (await api.patch("/api/v1/feeds/1", json={"name": "第三个名字"})).status_code == 409
    result = await finish(sessions)
    assert (result.title, result.season) == ("新番名", 1)
    assert fake.torrents[HASH]["name"] == "原始种子名称"


async def test_artwork_name_changes_without_downloads_and_can_reuse_identical_copy(season_app):
    api, sessions, fake, root = season_app
    async with sessions() as session:
        session.add(FeedSource(id=1, name="番名", url="https://example.test/rss"))
        await session.commit()
    _, paths = await add_artwork(sessions, root)
    target = root / "library" / "新番名" / "poster.jpg"
    target.parent.mkdir()
    target.write_bytes(Path(paths["poster_path"]).read_bytes())
    assert (await api.patch("/api/v1/feeds/1", json={"name": "新番名"})).status_code == 200
    async with sessions() as session:
        artwork = (await session.get(FeedSource, 1)).artwork
        assert artwork.poster_path == str(target)
        assert artwork.directory == str(target.parent)
        assert Path(artwork.clearlogo_path).read_bytes() == b"clearlogo.png"
    assert not fake.calls


async def test_artwork_io_failure_keeps_old_paths_and_does_not_start_qb(season_app, monkeypatch):
    from app import artwork_relocation

    api, sessions, fake, root = season_app
    await seed(sessions, fake, root)
    _, paths = await add_artwork(sessions, root)

    def fail(stream, output):
        output.write(b"partial")
        raise OSError("test copy failure")

    monkeypatch.setattr(artwork_relocation.shutil, "copyfileobj", fail)
    assert (await api.patch("/api/v1/feeds/1", json={"name": "新番名"})).status_code == 409
    async with sessions() as session:
        source = await session.get(FeedSource, 1)
        job = await session.get(DownloadJob, 1)
        assert source.name == job.title == "番名"
        assert source.artwork.poster_path == paths["poster_path"]
        assert job.state == "done"
    assert not (root / "library" / "新番名" / "poster.jpg").exists()
    assert all(Path(path).is_file() for path in paths.values())
    assert not fake.calls


async def test_renaming_inactive_metadata_task_preserves_pause(season_app):
    api, sessions, fake, root = season_app
    await seed(sessions, fake, root, state="metadata", active=False, running=False)
    assert (await api.patch("/api/v1/feeds/1", json={"name": "新番名"})).status_code == 200
    await finish(sessions)
    assert fake.torrents[HASH]["name"] == "原始种子名称"
    assert fake.torrents[HASH]["state"] == "stoppedUP"
    assert not any(endpoint == "start" for endpoint, _ in fake.calls)


@pytest.mark.parametrize("phase", ["name", "restore"])
async def test_legacy_migration_phase_syncs_tags_without_renaming_task(season_app, phase):
    api, sessions, fake, root = season_app
    await seed(sessions, fake, root)
    assert (await api.patch("/api/v1/feeds/1", json={"name": "新番名"})).status_code == 200
    for _ in range(25):
        await download_queue.process_queue()
        async with sessions() as session:
            job = await session.get(DownloadJob, 1)
            plan = json.loads(job.plan)
            if plan["season_change"]["phase"] == "tags":
                plan["season_change"]["phase"] = phase
                plan["season_change"]["name"] = "旧逻辑生成的任务名称"
                plan["season_change"]["target_plan"].pop("show_tag")
                job.plan = json.dumps(plan)
                await session.commit()
                break
    else:
        pytest.fail("did not reach tags phase")
    result = await finish(sessions)
    assert json.loads(result.plan)["show_tag"] == "新番名"
    assert fake.torrents[HASH]["name"] == "原始种子名称"
    assert set(fake.torrents[HASH]["tags"].split(", ")) == {"手动收藏", "保留标签", "新番名"}


async def test_metadata_tag_record_survives_rename_and_later_second_rename(season_app):
    api, sessions, fake, root = season_app
    await seed(sessions, fake, root, state="metadata", running=False)
    fake.torrents[HASH]["tags"] += ", 番名"
    async with sessions() as session:
        job = await session.get(DownloadJob, 1)
        job.plan = json.dumps({"show_tag": "番名"})
        await session.commit()
    for title in ("新番名", "第三个名字"):
        assert (await api.patch("/api/v1/feeds/1", json={"name": title})).status_code == 200
        result = await finish(sessions)
        assert json.loads(result.plan)["show_tag"] == title
        assert set(fake.torrents[HASH]["tags"].split(", ")) == {"手动收藏", "保留标签", title}
        assert fake.torrents[HASH]["name"] == "原始种子名称"


async def test_legacy_job_without_managed_tag_never_removes_manual_old_name_tag(season_app):
    api, sessions, fake, root = season_app
    await seed(sessions, fake, root)
    fake.torrents[HASH]["tags"] += ", 番名"
    async with sessions() as session:
        job = await session.get(DownloadJob, 1)
        plan = json.loads(job.plan)
        plan.pop("show_tag")
        job.plan = json.dumps(plan)
        await session.commit()
    assert (await api.patch("/api/v1/feeds/1", json={"name": "新番名"})).status_code == 200
    await finish(sessions)
    assert set(fake.torrents[HASH]["tags"].split(", ")) == {
        "手动收藏", "保留标签", "番名", "新番名",
    }
    assert not any(endpoint == "removeTags" for endpoint, _ in fake.calls)


async def test_migration_cleans_stale_empty_directories_but_preserves_active_tasks(season_app):
    api, sessions, fake, root = season_app
    await seed(sessions, fake, root, wrapper=True)
    temporary = root / "library" / ".mooncell"
    stale = temporary / "season-change" / HASH / "old-token" / "Season 01"
    stale.mkdir(parents=True)
    active = temporary / OTHER_HASH
    active.mkdir()
    fake.torrents[OTHER_HASH] = {"hash": OTHER_HASH, "save_path": str(active)}
    assert (await api.patch("/api/v1/feeds/1", json={"season": 2})).status_code == 200
    await finish(sessions)
    assert not (temporary / "season-change").exists()
    assert active.is_dir()


async def test_periodic_cleanup_removes_previously_completed_migration_directories(season_app):
    from app.staging_cleanup import cleanup_stale_temporary_directories

    _, sessions, fake, root = season_app
    await seed(sessions, fake, root)
    temporary = root / "library" / ".mooncell"
    (temporary / "season-change" / HASH / "old-token" / "Season 01").mkdir(parents=True)
    assert await cleanup_stale_temporary_directories() > 0
    assert not temporary.exists()
    assert fake.path(HASH, fake.files[HASH][0]["name"]).read_text(encoding="utf-8") == "content-0"
