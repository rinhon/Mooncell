import json
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from itertools import count
from pathlib import Path
from urllib.parse import parse_qs
from xml.etree import ElementTree

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import download_queue, rss_service
from app.database import Base
from app.models import DomainEvent, DownloaderConfig, DownloadJob, FeedItem, FeedSource
from app.release_parser import parse_release_title
from app.release_versions import release_identity

OLD_HASH = "a" * 40
NEW_HASH = "b" * 40
TITLE = "[桜都字幕组] Example / Example [01{}][1080P][简体内嵌]"


@pytest.mark.parametrize(
    "state,priority",
    [
        ("uploading", 0),
        ("checkingUP", 1),
        ("missingFiles", 1),
    ],
)
def test_completion_requires_selected_video_and_finished_checks(state, priority):
    from app.revision_upgrade import complete

    torrent = {"state": state, "progress": 1, "amount_left": 0}
    files = [
        {"name": "video.mkv", "progress": 1, "priority": priority},
        {"name": "notes.txt", "progress": 1, "priority": 1},
    ]
    assert not complete(torrent, files, {"video.mkv"})


@pytest.fixture
async def revision_database(monkeypatch, tmp_path):
    # 推进虚拟时间，验证接口故障后替换流程继续；真实退避边界另有专门用例。
    ticks = count()
    monkeypatch.setattr(
        download_queue,
        "retry_now",
        lambda: datetime(2026, 10, 18, tzinfo=UTC) + timedelta(minutes=16 * next(ticks)),
    )
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(download_queue, "SessionFactory", sessions)
    async with sessions() as session:
        session.add_all(
            [
                FeedSource(
                    id=1,
                    name="番名",
                    url="https://example.test/rss",
                    season=1,
                    excluded_keywords=["繁"],
                ),
                DownloaderConfig(
                    id=1,
                    name="qB",
                    kind="qbittorrent",
                    base_url="http://qb.test",
                    library_root=str(tmp_path),
                ),
            ]
        )
        await session.commit()
    yield sessions
    await engine.dispose()


async def add_release(session, revision, info_hash, title=None):
    raw = title or TITLE.format("" if revision == 1 else f"v{revision}")
    item = FeedItem(
        source_id=1,
        title=raw,
        fingerprint=info_hash,
        download_url=f"magnet:?xt=urn:btih:{info_hash}",
        parse_data=parse_release_title(raw).model_dump_json(),
    )
    session.add(item)
    await session.flush()
    return item


@pytest.mark.parametrize("reverse", [False, True])
async def test_real_rss_only_highest_revision_is_queued(revision_database, monkeypatch, reverse):
    rss_path = Path(__file__).resolve().parents[2] / "docs" / "Bangumi.rss"
    root = ElementTree.fromstring(rss_path.read_bytes())
    if reverse:
        channel = root.find("channel")
        entries = channel.findall("item")
        for entry in entries:
            channel.remove(entry)
        channel.extend(reversed(entries))
    content = ElementTree.tostring(root)
    original = httpx.AsyncClient
    monkeypatch.setattr(
        rss_service.httpx,
        "AsyncClient",
        lambda **kwargs: original(
            transport=httpx.MockTransport(lambda request: httpx.Response(200, content=content)),
        ),
    )
    async with revision_database() as session:
        source = await session.get(FeedSource, 1)
        for _ in range(2):
            await rss_service.FeedRefreshService(session).refresh(source)
        items = list(await session.scalars(select(FeedItem)))
        jobs = list(await session.scalars(select(DownloadJob)))
        assert len(items) == 2
        assert len(jobs) == 1
        chosen = await session.get(FeedItem, jobs[0].item_id)
        assert "[01v2][1080P][简体内嵌]" in chosen.title
        assert jobs[0].info_hash == "a5cc9b3c6fb36418a039e506e4221a68c5b02c47"
        assert sum(i.parse_status == "superseded" for i in items) == 1
        assert parse_release_title(chosen.title).revision == 2


@pytest.mark.parametrize("revisions", [(1, 2, 3), (3, 1, 2)])
async def test_queued_old_versions_never_submitted(revision_database, revisions):
    async with revision_database() as session:
        source = await session.get(FeedSource, 1)
        for revision in revisions:
            await add_release(session, revision, str(revision) * 40)
            await download_queue.enqueue_source(session, source)
        await session.commit()
        active = list(
            await session.scalars(
                select(DownloadJob).where(
                    DownloadJob.state == "queued",
                )
            )
        )
        assert len(active) == 1
        assert active[0].info_hash == "3" * 40


async def test_revision_inherits_manually_corrected_library_title(revision_database):
    async with revision_database() as session:
        old = await add_release(session, 1, OLD_HASH)
        source = await session.get(FeedSource, 1)
        await download_queue.enqueue_source(session, source)
        job = await session.scalar(select(DownloadJob))
        job.state = "done"
        job.title = "人工修正的番名"
        parsed = parse_release_title(old.title)
        parsed.title = job.title
        parsed.evidence.append("manual_review")
        old.parse_data = parsed.model_dump_json()
        new = await add_release(session, 2, NEW_HASH)
        await download_queue.enqueue_source(session, source)
        new_job = await session.scalar(select(DownloadJob).where(DownloadJob.item_id == new.id))
        assert new_job.title == job.title


async def test_same_revision_uses_one_stable_task_and_cannot_retry_superseded(revision_database):
    from fastapi import HTTPException

    from app.api import retry_download

    async with revision_database() as session:
        await add_release(session, 2, OLD_HASH)
        duplicate = await add_release(session, 2, NEW_HASH)
        source = await session.get(FeedSource, 1)
        for _ in range(2):
            await download_queue.enqueue_source(session, source)
        assert len(list(await session.scalars(select(DownloadJob)))) == 1
        assert duplicate.parse_status == "superseded"
        with pytest.raises(HTTPException) as error:
            await retry_download(duplicate.id, _user=None, session=session)
        assert error.value.status_code == 409


@pytest.mark.parametrize(
    "other",
    [
        "[其他字幕组] Example / Example [01v2][1080P][简体内嵌]",
        TITLE.format("v2").replace("1080P", "720P"),
        TITLE.format("v2").replace("简体内嵌", "繁体内嵌"),
        TITLE.format("v2").replace("内嵌", "内封"),
        TITLE.format("v2").replace("[01v2]", "[02v2]"),
        TITLE.format("v2").replace("Example / Example", "Other / Other"),
    ],
)
async def test_different_specs_are_not_revision_candidates(revision_database, other):
    async with revision_database() as session:
        old = await add_release(session, 1, OLD_HASH)
        new = await add_release(session, 2, NEW_HASH, other)
        source = await session.get(FeedSource, 1)
        assert release_identity(old, source) != release_identity(new, source)
        await download_queue.enqueue_source(session, source)
        assert len(list(await session.scalars(select(DownloadJob)))) == 2


class FakeQB:
    """模拟下载器并移动实际测试文件，验证清理不能触及新版或其他集数。"""

    def __init__(self, root, wrapper, fail_promotion=False):
        self.root = root
        self.wrapper = wrapper
        self.fail_promotion = fail_promotion
        self.torrents = {}
        self.files = {}
        self.calls = []
        self.deleted_paths = []
        self.fail_after_move = None
        self.failed_once = False

    def file_path(self, info_hash, name):
        path = Path(self.torrents[info_hash]["save_path"]) / name
        assert path.resolve().is_relative_to(self.root.resolve())
        return path

    def handle(self, request):
        endpoint = request.url.path.rsplit("/", 1)[-1]
        data = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
        info_hash = data.get("hashes") or data.get("hash") or request.url.params.get("hashes")
        self.calls.append((endpoint, info_hash, data))
        if endpoint == "login":
            return httpx.Response(200, text="Ok.")
        if endpoint == "info":
            values = (
                ([self.torrents[info_hash]] if info_hash in self.torrents else [])
                if info_hash
                else list(self.torrents.values())
            )
            return httpx.Response(200, json=deepcopy(values))
        if endpoint == "files":
            return httpx.Response(200, json=deepcopy(self.files[request.url.params["hash"]]))
        if endpoint == "add":
            info_hash = NEW_HASH
            self.torrents[info_hash] = {
                "save_path": data["savepath"],
                "state": "stoppedDL",
                "progress": 0,
                "amount_left": 100,
                "tags": data["tags"],
            }
            self.files[info_hash] = [
                {
                    "name": ("Pack/" if self.wrapper else "") + "video.mkv",
                    "priority": 1,
                    "progress": 0,
                }
            ]
            path = self.file_path(info_hash, self.files[info_hash][0]["name"])
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("new", encoding="utf-8")
            return httpx.Response(200, text="Ok.")
        if endpoint in {"start", "stop"}:
            self.torrents[info_hash]["state"] = (
                "downloading" if endpoint == "start" else "stoppedDL"
            )
        if endpoint in {"renameFile", "renameFolder"}:
            for file in self.files[info_hash]:
                old_name = file["name"]
                if endpoint == "renameFile" and old_name == data["oldPath"]:
                    file["name"] = data["newPath"]
                elif endpoint == "renameFolder":
                    file["name"] = old_name.replace(data["oldPath"] + "/", data["newPath"] + "/")
                if old_name != file["name"]:
                    target = self.file_path(info_hash, file["name"])
                    target.parent.mkdir(parents=True, exist_ok=True)
                    self.file_path(info_hash, old_name).replace(target)
        if endpoint == "setLocation":
            if (
                info_hash == NEW_HASH
                and ".mooncell" not in data["location"]
                and self.fail_promotion
            ):
                return httpx.Response(409)
            old_paths = [
                (f["name"], self.file_path(info_hash, f["name"])) for f in self.files[info_hash]
            ]
            self.torrents[info_hash]["save_path"] = data["location"]
            for name, path in old_paths:
                target = self.file_path(info_hash, name)
                assert not target.exists()
                target.parent.mkdir(parents=True, exist_ok=True)
                path.replace(target)
            if info_hash == self.fail_after_move and not self.failed_once:
                self.failed_once = True
                return httpx.Response(500)
        if endpoint == "delete":
            assert data["deleteFiles"] == "true"
            assert info_hash == OLD_HASH
            assert "replaced" in Path(self.torrents[info_hash]["save_path"]).parts
            for file in self.files[info_hash]:
                path = self.file_path(info_hash, file["name"])
                self.deleted_paths.append(path)
                path.unlink()
            del self.torrents[info_hash]
        return httpx.Response(200)


async def existing_old_version(sessions, fake, extension="mkv"):
    async with sessions() as session:
        item = await add_release(session, 1, OLD_HASH)
        source = await session.get(FeedSource, 1)
        await download_queue.enqueue_source(session, source)
        old = await session.scalar(select(DownloadJob))
        filename = f"番名 S01E01.{extension}"
        name = "Season 01/" + filename if fake.wrapper else filename
        old.plan = json.dumps(
            {
                "wrapper": "Pack" if fake.wrapper else None,
                "season_folder": "Season 01",
                "files": [{"old": name, "new": name}],
                "selection_version": 2,
                "skip_file_ids": [],
            }
        )
        old.state = "done"
        location = fake.root / "番名"
        if not fake.wrapper:
            location /= "Season 01"
        fake.torrents[OLD_HASH] = {
            "state": "uploading",
            "save_path": str(location),
            "progress": 1,
            "amount_left": 0,
        }
        fake.files[OLD_HASH] = [{"name": name, "priority": 1, "progress": 1}]
        old_path = fake.file_path(OLD_HASH, name)
        old_path.parent.mkdir(parents=True, exist_ok=True)
        old_path.write_text("old", encoding="utf-8")
        await add_release(session, 2, NEW_HASH)
        await download_queue.enqueue_source(session, source)
        await session.commit()
        assert item.parse_status == "parsed"  # 新版完成前仍保留旧版。
        return old_path


@pytest.mark.parametrize("wrapper", [False, True])
@pytest.mark.parametrize("fail_promotion", [False, True])
@pytest.mark.parametrize("old_extension", ["mkv", "mp4"])
async def test_upgrade_completion_cleanup_and_rollback(
    revision_database,
    monkeypatch,
    tmp_path,
    wrapper,
    fail_promotion,
    old_extension,
):
    fake = FakeQB(tmp_path, wrapper, fail_promotion)
    old_path = await existing_old_version(revision_database, fake, old_extension)
    unrelated = old_path.parent / "番名 S01E02.mkv"
    unrelated.write_text("other episode", encoding="utf-8")
    original = httpx.AsyncClient
    monkeypatch.setattr(
        download_queue.httpx,
        "AsyncClient",
        lambda **kwargs: original(
            base_url="http://qb.test",
            transport=httpx.MockTransport(fake.handle),
        ),
    )
    for _ in range(12):
        await download_queue.process_queue()
    assert old_path.read_text(encoding="utf-8") == "old"
    assert not fake.deleted_paths
    async with revision_database() as session:
        new = await session.scalar(select(DownloadJob).where(DownloadJob.info_hash == NEW_HASH))
        assert new.state == "upgrading"
    # 即使种子整体显示完成，只要文件未完成，也不能替换。
    fake.torrents[NEW_HASH].update(progress=1, amount_left=0)
    for _ in range(2):
        await download_queue.process_queue()
    assert old_path.exists()
    fake.files[NEW_HASH][0]["progress"] = 1
    for _ in range(16):  # 每轮新建会话，验证服务重启后持久化步骤能够恢复。
        await download_queue.process_queue()
    async with revision_database() as session:
        jobs = list(await session.scalars(select(DownloadJob).order_by(DownloadJob.id)))
        old, new = jobs
        if fail_promotion:
            assert old.state == "done"
            assert new.state == "needs_review"
            assert "已恢复旧版" in new.last_error
            assert old_path.read_text(encoding="utf-8") == "old"
            assert not fake.deleted_paths
            assert fake.torrents[OLD_HASH]["state"] == "downloading"
            temporary = fake.root / ".mooncell"
            assert not (temporary / "replaced").exists()
            assert (temporary / NEW_HASH).is_dir()  # 新版仍留在暂存目录等待审核。
        else:
            assert old.state == "superseded"
            assert new.state == "done"
            assert (await session.get(FeedItem, old.item_id)).parse_status == "superseded"
            assert len(fake.deleted_paths) == 1
            assert (old_path.parent / "番名 S01E01.mkv").read_text(encoding="utf-8") == "new"
            assert OLD_HASH not in fake.torrents
            assert not (fake.root / ".mooncell").exists()
            assert (
                await session.scalar(
                    select(DomainEvent).where(
                        DomainEvent.event_type == "download.upgraded",
                    )
                )
                is not None
            )
        assert unrelated.read_text(encoding="utf-8") == "other episode"
        await download_queue.enqueue_source(session, await session.get(FeedSource, 1))
        assert len(list(await session.scalars(select(DownloadJob)))) == 2


@pytest.mark.parametrize("fail_after_move", [OLD_HASH, NEW_HASH])
async def test_ambiguous_api_failure_after_move_recovers(
    revision_database,
    monkeypatch,
    tmp_path,
    fail_after_move,
):
    fake = FakeQB(tmp_path, False)
    fake.fail_after_move = fail_after_move
    old_path = await existing_old_version(revision_database, fake)
    original = httpx.AsyncClient
    monkeypatch.setattr(
        download_queue.httpx,
        "AsyncClient",
        lambda **kwargs: original(
            base_url="http://qb.test",
            transport=httpx.MockTransport(fake.handle),
        ),
    )
    for _ in range(10):
        await download_queue.process_queue()
    fake.torrents[NEW_HASH].update(progress=1, amount_left=0)
    fake.files[NEW_HASH][0]["progress"] = 1
    for _ in range(18):
        await download_queue.process_queue()
    assert fake.failed_once
    async with revision_database() as session:
        new = await session.scalar(select(DownloadJob).where(DownloadJob.info_hash == NEW_HASH))
        if fail_after_move == OLD_HASH:
            assert new.state == "done"
            assert old_path.read_text(encoding="utf-8") == "new"
        else:
            assert new.state == "needs_review"
            assert "已恢复旧版" in new.last_error
            assert old_path.read_text(encoding="utf-8") == "old"
            assert not fake.deleted_paths


async def test_unrelated_spec_conflict_does_not_replace_old(
    revision_database,
    monkeypatch,
    tmp_path,
):
    fake = FakeQB(tmp_path, False)
    old_path = await existing_old_version(revision_database, fake)
    async with revision_database() as session:
        new = await session.scalar(select(FeedItem).where(FeedItem.fingerprint == NEW_HASH))
        new.title = new.title.replace("桜都字幕组", "其他字幕组")
        new.parse_data = parse_release_title(new.title).model_dump_json()
        await session.commit()
    original = httpx.AsyncClient
    monkeypatch.setattr(
        download_queue.httpx,
        "AsyncClient",
        lambda **kwargs: original(
            base_url="http://qb.test",
            transport=httpx.MockTransport(fake.handle),
        ),
    )
    for _ in range(12):
        await download_queue.process_queue()
    async with revision_database() as session:
        new = await session.scalar(select(DownloadJob).where(DownloadJob.info_hash == NEW_HASH))
        assert new.state == "needs_review"
        assert "冲突" in new.last_error
    assert old_path.read_text(encoding="utf-8") == "old"
    assert not fake.deleted_paths


@pytest.mark.parametrize("fail_promotion", [False, True])
async def test_playing_old_version_defers_replacement_until_release(
    revision_database,
    monkeypatch,
    tmp_path,
    fail_promotion,
):
    from app.playback.leases import (
        acquire_source,
        ensure_source_available,
        finish_mutation,
        release_source,
    )
    from app.playback.media import MediaError

    finish_mutation(1)
    fake = FakeQB(tmp_path, False, fail_promotion)
    old_path = await existing_old_version(revision_database, fake)
    original = httpx.AsyncClient
    monkeypatch.setattr(
        download_queue.httpx,
        "AsyncClient",
        lambda **kwargs: original(
            base_url="http://qb.test",
            transport=httpx.MockTransport(fake.handle),
        ),
    )
    for _ in range(12):
        await download_queue.process_queue()
    acquire_source(1)
    try:
        fake.torrents[NEW_HASH].update(progress=1, amount_left=0)
        fake.files[NEW_HASH][0]["progress"] = 1
        for _ in range(4):
            await download_queue.process_queue()
        assert old_path.read_text(encoding="utf-8") == "old"
        assert not fake.deleted_paths
        async with revision_database() as session:
            job = await session.scalar(select(DownloadJob).where(DownloadJob.info_hash == NEW_HASH))
            assert json.loads(job.plan)["replacement"]["phase"] == "downloading"
            assert "正在播放旧版文件" in job.last_error
        with pytest.raises(MediaError):
            acquire_source(1)
        release_source(1)
        for _ in range(18):
            await download_queue.process_queue()
        ensure_source_available(1)
        async with revision_database() as session:
            job = await session.scalar(select(DownloadJob).where(DownloadJob.info_hash == NEW_HASH))
            assert job.state == ("needs_review" if fail_promotion else "done")
    finally:
        release_source(1)
        finish_mutation(1)
