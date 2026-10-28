import json
from datetime import UTC, datetime, timedelta
from email import policy
from email.parser import BytesParser
from pathlib import PurePosixPath
from types import SimpleNamespace
from urllib.parse import parse_qs

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import download_queue, rss_service
from app.database import Base
from app.download_queue import build_plan, language_preference, remote_root
from app.models import (
    DomainEvent,
    DownloaderConfig,
    DownloadJob,
    FeedItem,
    FeedSource,
    LibrarySettings,
    SubscriptionSettings,
)
from app.release_parser import parse_release_title

RELEASE = parse_release_title("[Group] Example - 05 [1080p]")
HASH = "a" * 40


@pytest.mark.parametrize("wrapper", [False, True])
def test_file_layout_and_subscription_season(wrapper):
    prefix = "Original/" if wrapper else ""
    plan = build_plan([{"name": prefix + "video.mkv"}], "番名", 2, RELEASE)
    assert plan["wrapper"] == ("Original" if wrapper else None)
    assert plan["files"][0]["new"] == ("Season 02/" if wrapper else "") + "番名 S02E05.mkv"


def test_multiple_videos_require_individual_episodes_and_reject_collisions():
    files = [{"name": f"Batch/Example - {ep} [1080p].mkv"} for ep in [1, 2]]
    plan = build_plan(files, "番名", 3, RELEASE)
    assert [f["new"] for f in plan["files"]] == [
        "Season 03/番名 S03E01.mkv",
        "Season 03/番名 S03E02.mkv",
    ]
    with pytest.raises(ValueError, match="集数"):
        build_plan([{"name": "a.mkv"}, {"name": "b.mkv"}], "番名", 1, RELEASE)
    with pytest.raises(ValueError, match="冲突"):
        build_plan([{"name": "A S01E01.mkv"}, {"name": "B S01E01.mkv"}], "番名", 1, RELEASE)
    with pytest.raises(ValueError, match="无效"):
        build_plan([{"name": "../a.mkv"}], "番名", 1, RELEASE)


def test_remote_path_mapping():
    config = SimpleNamespace(local_download_root="F:\\Media", remote_download_root="/media")
    assert remote_root("F:\\Media\\Anime", config) == "/media/Anime"
    with pytest.raises(ValueError, match="映射范围"):
        remote_root("F:\\Other", config)


@pytest.fixture
async def database(monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(download_queue, "SessionFactory", sessions)
    async with sessions() as session:
        source = FeedSource(name="番名", season=2, url="https://example.test/rss")
        config = DownloaderConfig(name="qB", kind="qbittorrent", base_url="http://qb.test")
        session.add_all([source, config, LibrarySettings(id=1, library_root="/media")])
        await session.flush()
        session.add(
            FeedItem(
                source_id=source.id,
                title=RELEASE.raw_title,
                download_url=f"magnet:?xt=urn:btih:{HASH}",
                fingerprint="first",
                parse_data=RELEASE.model_dump_json(),
            )
        )
        await session.commit()
    yield sessions
    await engine.dispose()


@pytest.mark.parametrize(
    ("error", "reason"),
    [
        (httpx.ReadError(""), "读取下载器响应失败"),
        (httpx.ConnectError("All connection attempts failed"), "无法连接下载器"),
    ],
)
async def test_download_network_failure_is_saved_in_chinese(database, monkeypatch, error, reason):
    async def fail_job(*args):
        raise error

    monkeypatch.setattr(download_queue, "process_job", fail_job)
    async with database() as session:
        await download_queue.enqueue_source(session, await session.get(FeedSource, 1))
        await session.commit()
    await download_queue.process_queue()
    await download_queue.process_queue()
    async with database() as session:
        job = await session.scalar(select(DownloadJob))
        events = list(
            await session.scalars(
                select(DomainEvent).where(DomainEvent.event_type == "download.failed")
            )
        )
        assert reason in job.last_error
        assert type(error).__name__ in job.last_error
        assert len(events) == 1, "重复失败不应重复写入相同日志"
        assert json.loads(events[0].payload)["error"] == job.last_error


@pytest.mark.parametrize("failure", ["network", "rejected", "server"])
async def test_retry_backoff_survives_sessions_and_recovers(database, monkeypatch, failure):
    now = datetime(2026, 10, 18, tzinfo=UTC)
    monkeypatch.setattr(download_queue, "retry_now", lambda: now)
    attempts = 0
    recovered = False

    async def process(*args):
        nonlocal attempts
        attempts += 1
        if recovered:
            return
        if failure == "network":
            raise httpx.ReadTimeout("timeout")
        if failure == "server":
            response = httpx.Response(503, request=httpx.Request("POST", "http://qb.test/add"))
            response.raise_for_status()
        raise download_queue.DownloadDeliveryError("qBittorrent 未接受种子文件")

    monkeypatch.setattr(download_queue, "process_job", process)
    async with database() as session:
        await download_queue.enqueue_source(session, await session.get(FeedSource, 1))
        await session.commit()
    for index, delay in enumerate([30, 60, 120, 240, 480, 900, 900], start=1):
        await download_queue.process_queue()
        async with database() as session:
            job = await session.scalar(select(DownloadJob))
            assert job.retry_attempts == index
            assert job.next_retry_at.replace(tzinfo=UTC) == now + timedelta(seconds=delay)
        now += timedelta(seconds=delay - 1)
        await download_queue.process_queue()
        assert attempts == index, "新会话不能绕过持久化等待时间"
        now += timedelta(seconds=1)
    recovered = True
    await download_queue.process_queue()
    await download_queue.process_queue()
    async with database() as session:
        job = await session.scalar(select(DownloadJob))
        assert (job.retry_attempts, job.next_retry_at, job.last_error) == (0, None, None)
        events = list(await session.scalars(select(DomainEvent)))
        assert sum(event.event_type == "download.failed" for event in events) == 1
        assert sum(event.event_type == "download.recovered" for event in events) == 1


async def test_immediate_retry_preserves_progress(database):
    from app import api

    async with database() as session:
        await download_queue.enqueue_source(session, await session.get(FeedSource, 1))
        job = await session.scalar(select(DownloadJob))
        job.state = "organizing"
        job.plan = '{"files": [{"old": "a", "new": "b"}]}'
        job.last_error = "读取下载器响应失败"
        job.retry_attempts = 3
        job.next_retry_at = datetime.now(UTC) + timedelta(minutes=15)
        await session.commit()
        plan = job.plan
        await api.retry_download_automation(1, _user=None, session=session)
        assert job.next_retry_at is None
        assert (job.state, job.plan, job.retry_attempts) == ("organizing", plan, 3)


async def test_download_center_exposes_retry_time_with_timezone(database, monkeypatch):
    from app import api

    async def offline(*args):
        raise httpx.ConnectError("All connection attempts failed")

    monkeypatch.setattr(api, "get_qbittorrent_snapshot", offline)
    async with database() as session:
        await download_queue.enqueue_source(session, await session.get(FeedSource, 1))
        job = await session.scalar(select(DownloadJob))
        job.retry_attempts = 2
        job.last_error = "无法连接下载器"
        job.next_retry_at = datetime(2026, 10, 18, 1, 2, 3)
        await session.commit()
        data = await api.download_center(_user=None, session=session)
        assert "无法连接下载器" in data.error
        assert data.tasks[0].retry_attempts == 2
        assert data.tasks[0].next_retry_at == datetime(2026, 10, 18, 1, 2, 3, tzinfo=UTC)


@pytest.mark.parametrize("invalid", ["missing", "done", "disabled", "healthy"])
async def test_immediate_retry_rejects_invalid_jobs(database, invalid):
    from fastapi import HTTPException

    from app import api

    async with database() as session:
        if invalid != "missing":
            await download_queue.enqueue_source(session, await session.get(FeedSource, 1))
            job = await session.scalar(select(DownloadJob))
            job.last_error = "失败"
            if invalid == "done":
                job.state = "done"
            elif invalid == "disabled":
                (await session.get(FeedSource, 1)).active = False
            elif invalid == "healthy":
                job.last_error = None
            await session.commit()
        with pytest.raises(HTTPException) as error:
            await api.retry_download_automation(1, _user=None, session=session)
        assert error.value.status_code == (404 if invalid == "missing" else 409)


async def test_accepted_torrent_with_lost_response_is_not_added_twice(database, monkeypatch):
    now = datetime(2026, 10, 18, tzinfo=UTC)
    monkeypatch.setattr(download_queue, "retry_now", lambda: now)
    accepted = False
    additions = 0

    def handle(request):
        nonlocal accepted, additions
        endpoint = request.url.path.rsplit("/", 1)[-1]
        if endpoint == "login":
            return httpx.Response(200, text="Ok.")
        if endpoint == "info":
            return httpx.Response(
                200,
                json=[
                    {
                        "save_path": f"/media/.mooncell/{HASH}",
                        "state": "metaDL",
                    }
                ]
                if accepted
                else [],
            )
        assert endpoint == "add"
        accepted = True
        additions += 1
        raise httpx.ReadTimeout("response lost", request=request)

    original_client = httpx.AsyncClient
    monkeypatch.setattr(
        download_queue.httpx,
        "AsyncClient",
        lambda **kwargs: original_client(
            **kwargs,
            transport=httpx.MockTransport(handle),
        ),
    )
    async with database() as session:
        await download_queue.enqueue_source(session, await session.get(FeedSource, 1))
        await session.commit()
    await download_queue.process_queue()
    now += timedelta(seconds=30)
    await download_queue.process_queue()
    assert additions == 1
    async with database() as session:
        job = await session.scalar(select(DownloadJob))
        assert job.state == "metadata"
        assert job.last_error is None
        assert job.next_retry_at is None


@pytest.mark.parametrize("result", ["valid", "html", "http_error", "network_error", "qb_reject"])
async def test_http_torrent_is_fetched_with_proxy_and_uploaded(database, monkeypatch, result):
    torrent = b"d4:infod4:name7:exampleee"
    proxy = "http://127.0.0.1:7890/"
    url = f"https://mikanani.me/Download/{HASH}.torrent"
    async with database() as session:
        item = await session.get(FeedItem, 1)
        item.download_url = url
        session.add(SubscriptionSettings(id=1, proxy_url=proxy))
        await download_queue.enqueue_source(session, await session.get(FeedSource, 1))
        await session.commit()
    uploads = []

    def qb_transport(request):
        endpoint = request.url.path.rsplit("/", 1)[-1]
        if endpoint == "login":
            return httpx.Response(200, text="Ok.")
        if endpoint == "info":
            return httpx.Response(200, json=[])
        assert endpoint == "add"
        assert request.headers["content-type"].startswith("multipart/form-data;")
        mime = BytesParser(policy=policy.default).parsebytes(
            b"Content-Type: "
            + request.headers["content-type"].encode()
            + b"\r\n\r\n"
            + request.content
        )
        parts = {
            part.get_param("name", header="content-disposition"): part for part in mime.iter_parts()
        }
        assert "urls" not in parts, "不能再要求 qB 自行连接种子源站"
        assert parts["torrents"].get_payload(decode=True) == torrent
        assert parts["torrents"].get_filename() == f"{HASH}.torrent"
        assert parts["savepath"].get_payload(decode=True).decode() == f"/media/.mooncell/{HASH}"
        assert parts["stopCondition"].get_payload(decode=True) == b"MetadataReceived"
        assert parts["tags"].get_payload(decode=True).decode() == "番名"
        uploads.append(request)
        return httpx.Response(200, text="Fails." if result == "qb_reject" else "Ok.")

    def source_transport(request):
        assert str(request.url) == url
        assert request.headers["user-agent"] == download_queue.settings.rss_user_agent
        if result == "network_error":
            raise httpx.ConnectError("source offline", request=request)
        if result == "http_error":
            return httpx.Response(403)
        content = "<html>访问限制</html>".encode() if result == "html" else torrent
        return httpx.Response(200, content=content)

    original_client = httpx.AsyncClient

    def client(**kwargs):
        if kwargs.get("base_url"):
            return original_client(**kwargs, transport=httpx.MockTransport(qb_transport))
        assert kwargs["proxy"] == proxy
        assert kwargs["trust_env"] is False
        kwargs.pop("proxy")  # 测试传输替代代理，不连接任何真实服务。
        return original_client(**kwargs, transport=httpx.MockTransport(source_transport))

    monkeypatch.setattr(download_queue.httpx, "AsyncClient", client)
    await download_queue.process_queue()
    async with database() as session:
        job = await session.scalar(select(DownloadJob))
        if result == "valid":
            assert len(uploads) == 1
            assert job.state == "metadata"
            assert job.last_error is None
        else:
            assert job.state == "queued"
            assert "种子" in job.last_error
            assert len(uploads) == int(result == "qb_reject")
            if result == "http_error":
                assert "HTTP 403" in job.last_error
            if result == "network_error":
                assert "种子文件获取失败" in job.last_error


async def test_refresh_304_enqueues_existing_records_idempotently(database, monkeypatch):
    original_client = httpx.AsyncClient
    monkeypatch.setattr(
        rss_service.httpx,
        "AsyncClient",
        lambda **kwargs: original_client(
            transport=httpx.MockTransport(lambda request: httpx.Response(304)),
        ),
    )
    async with database() as session:
        source = await session.get(FeedSource, 1)
        for _ in range(2):
            result = await rss_service.FeedRefreshService(session).refresh(source)
            assert result.not_modified
        jobs = list(await session.scalars(select(DownloadJob)))
        assert len(jobs) == 1
        assert jobs[0].season == 2


@pytest.mark.parametrize("wrapper", [False, True])
@pytest.mark.parametrize("transient_failure", [False, True])
@pytest.mark.parametrize("bilingual", [False, True])
async def test_queue_add_rename_move_and_restart(
    database,
    monkeypatch,
    wrapper,
    transient_failure,
    bilingual,
):
    async with database() as session:
        await download_queue.enqueue_source(session, await session.get(FeedSource, 1))
        await session.commit()
    state = {"torrent": None, "files": [{"name": ("Original/" if wrapper else "") + "video.mkv"}]}
    if bilingual:
        state["files"] = [
            {
                "index": index,
                "priority": 1,
                "name": ("Original/" if wrapper else "") + f"video [{language}].mkv",
            }
            for index, language in [(4, "CHT"), (9, "CHS")]
        ]
    calls = []
    failed_once = False

    def handle(request):
        nonlocal failed_once
        endpoint = request.url.path.rsplit("/", 1)[-1]
        data = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
        calls.append(endpoint)
        failing_endpoint = "filePrio" if bilingual else "renameFile"
        if endpoint == failing_endpoint and transient_failure and not failed_once:
            failed_once = True
            return httpx.Response(409)
        if endpoint == "login":
            return httpx.Response(200, text="Ok.")
        if endpoint == "info":
            return httpx.Response(200, json=[state["torrent"]] if state["torrent"] else [])
        if endpoint == "add":
            assert data["contentLayout"] == "Original"
            assert data["stopCondition"] == "MetadataReceived"
            assert data["tags"] == "番名"
            assert "rename" not in data
            state["torrent"] = {
                "save_path": data["savepath"],
                "state": "metaDL",
                "name": "原始种子名称",
                "tags": data["tags"],
            }
            return httpx.Response(200, text="Ok.")
        if endpoint == "files":
            return httpx.Response(200, json=state["files"])
        if endpoint in {"start", "stop"}:
            state["torrent"]["state"] = "downloading" if endpoint == "start" else "stoppedDL"
        if endpoint == "filePrio":
            assert data["id"] == "4"
            assert data["priority"] == "0"
            assert state["torrent"]["state"] == "stoppedDL"
            state["files"][0]["priority"] = 0
        if endpoint == "start" and bilingual:
            assert state["files"][0]["priority"] == 0
            assert state["files"][1]["priority"] == 1
        if endpoint == "renameFolder":
            for file in state["files"]:
                file["name"] = file["name"].replace(data["oldPath"] + "/", data["newPath"] + "/", 1)
        if endpoint == "renameFile":
            for file in state["files"]:
                if file["name"] == data["oldPath"]:
                    file["name"] = data["newPath"]
        if endpoint == "setLocation":
            state["torrent"]["save_path"] = data["location"]
        return httpx.Response(200)

    original_client = httpx.AsyncClient
    monkeypatch.setattr(
        download_queue.httpx,
        "AsyncClient",
        lambda **kwargs: original_client(
            base_url="http://qb.test",
            transport=httpx.MockTransport(handle),
        ),
    )
    await download_queue.process_queue()
    await download_queue.process_queue()
    assert "files" not in calls  # 元数据还没到，不能凭 RSS 标题猜目录。
    state["torrent"]["state"] = "downloading"
    for _ in range(10):  # 每一轮都用新的数据库会话，模拟进程恢复后的持久化进度。
        await download_queue.process_queue()
    assert calls.count("add") == 1
    assert "rename" not in calls
    assert state["torrent"]["name"] == "原始种子名称"
    assert state["torrent"]["tags"] == "番名"
    assert calls.count("renameFolder") == int(wrapper)
    assert calls.count("renameFile") == 1 + int(transient_failure and not bilingual)
    assert calls.count("filePrio") == (1 + int(transient_failure) if bilingual else 0)
    assert calls.count("start") == 1
    assert state["torrent"]["save_path"] == ("/media/番名" if wrapper else "/media/番名/Season 02")
    assert state["files"][-1]["name"] == ("Season 02/" if wrapper else "") + "番名 S02E05.mkv"
    async with database() as session:
        job = await session.scalar(select(DownloadJob))
        assert job.state == "done"
        assert job.last_error is None
        assert json.loads(job.plan)["season_folder"] == "Season 02"
        assert json.loads(job.plan)["show_tag"] == "番名"


async def test_inactive_and_review_items_not_enqueued(database):
    async with database() as session:
        item = await session.get(FeedItem, 1)
        item.parse_status = "needs_review"
        source = await session.get(FeedSource, 1)
        await download_queue.enqueue_source(session, source)
        assert await session.scalar(select(DownloadJob)) is None
        item.parse_status = "parsed"
        source.active = False
        await download_queue.enqueue_source(session, source)
        assert await session.scalar(select(DownloadJob)) is None


@pytest.mark.parametrize("existing", [False, True])
async def test_first_submission_tags_and_does_not_touch_external_torrent(
    database,
    monkeypatch,
    existing,
):
    async with database() as session:
        source = await session.get(FeedSource, 1)
        source.name = "Hello, World"
        await download_queue.enqueue_source(session, source)
        await session.commit()
    calls = []

    def handle(request):
        endpoint = request.url.path.rsplit("/", 1)[-1]
        data = {key: values[0] for key, values in parse_qs(request.content.decode()).items()}
        calls.append((endpoint, data))
        if endpoint == "info":
            return httpx.Response(
                200,
                json=[
                    {
                        "save_path": "/manual-downloads",
                        "state": "downloading",
                        "name": "用户自己的任务",
                        "tags": "手动标签",
                    }
                ]
                if existing
                else [],
            )
        if endpoint == "add":
            assert data["tags"] == "Hello， World"
            assert "rename" not in data
        else:
            assert endpoint == "login"
        return httpx.Response(200, text="Ok.")

    original_client = httpx.AsyncClient
    monkeypatch.setattr(
        download_queue.httpx,
        "AsyncClient",
        lambda **kwargs: original_client(
            base_url="http://qb.test",
            transport=httpx.MockTransport(handle),
        ),
    )
    await download_queue.process_queue()
    assert [endpoint for endpoint, _ in calls] == (
        ["login", "info"] if existing else ["login", "info", "add"]
    )
    async with database() as session:
        job = await session.scalar(select(DownloadJob))
        assert job.state == ("existing" if existing else "metadata")
        if existing:
            assert job.plan is None
        else:
            assert json.loads(job.plan) == {"show_tag": "Hello， World"}


@pytest.mark.parametrize("previous_state", [None, "metadata", "done", "needs_review"])
async def test_manual_retry_creates_or_resets_job_and_submits(
    database,
    monkeypatch,
    previous_state,
):
    from app import api

    async def snapshot(*args):
        return SimpleNamespace(torrents={})

    monkeypatch.setattr(api, "get_qbittorrent_snapshot", snapshot)
    async with database() as session:
        if previous_state:
            await download_queue.enqueue_source(session, await session.get(FeedSource, 1))
            job = await session.scalar(select(DownloadJob))
            job.state = previous_state
            job.plan = '{"old": true}'
            job.last_error = "下载器中不存在"
            await session.commit()
        for _ in range(2):
            result = await api.retry_download(1, _user=None, session=session)
            assert "队列" in result.message
        jobs = list(await session.scalars(select(DownloadJob)))
        assert len(jobs) == 1
        assert jobs[0].state == "queued"
        assert jobs[0].last_error is None
        assert jobs[0].plan is None
        assert jobs[0].season == 2

    calls = []

    def respond(request):
        endpoint = request.url.path.rsplit("/", 1)[-1]
        calls.append(endpoint)
        if endpoint == "info":
            return httpx.Response(200, json=[])
        return httpx.Response(200, text="Ok.")

    original_client = httpx.AsyncClient
    monkeypatch.setattr(
        download_queue.httpx,
        "AsyncClient",
        lambda **kwargs: original_client(
            base_url="http://qb.test",
            transport=httpx.MockTransport(respond),
        ),
    )
    await download_queue.process_queue()
    assert calls.count("add") == 1
    async with database() as session:
        job = await session.scalar(select(DownloadJob))
        assert job.state == "metadata"
        assert job.last_error is None


@pytest.mark.parametrize("offline", [False, True])
async def test_manual_retry_keeps_state_when_existing_or_offline(database, monkeypatch, offline):
    from fastapi import HTTPException

    from app import api

    async def snapshot(*args):
        if offline:
            raise httpx.ConnectError("offline")
        return SimpleNamespace(torrents={HASH: {"state": "downloading"}})

    monkeypatch.setattr(api, "get_qbittorrent_snapshot", snapshot)
    async with database() as session:
        await download_queue.enqueue_source(session, await session.get(FeedSource, 1))
        job = await session.scalar(select(DownloadJob))
        job.state = "done"
        job.plan = '{"keep": true}'
        await session.commit()
        with pytest.raises(HTTPException) as error:
            await api.retry_download(1, _user=None, session=session)
        assert error.value.status_code == (503 if offline else 409)
        assert job.state == "done"
        assert job.plan == '{"keep": true}'


@pytest.mark.parametrize("invalid", ["disabled", "review", "no_hash", "bad_parse", "no_config"])
async def test_manual_retry_rejects_invalid_records(database, invalid):
    from fastapi import HTTPException

    from app import api

    async with database() as session:
        item = await session.get(FeedItem, 1)
        if invalid == "disabled":
            (await session.get(FeedSource, 1)).active = False
        elif invalid == "review":
            item.parse_status = "needs_review"
        elif invalid == "no_hash":
            item.download_url = "https://example.test/file.torrent"
        elif invalid == "bad_parse":
            item.parse_data = "invalid"
        else:
            (await session.get(DownloaderConfig, 1)).active = False
        await session.commit()
        with pytest.raises(HTTPException) as error:
            await api.retry_download(1, _user=None, session=session)
        assert error.value.status_code in {409, 422}
        assert await session.scalar(select(DownloadJob)) is None


@pytest.mark.parametrize(
    "simple,traditional",
    [
        ("CHS", "CHT"),
        ("GB", "BIG5"),
        ("简中", "繁中"),
        ("簡體", "繁體"),
        ("zh-Hans", "zh-Hant"),
        ("SC", "TC"),
    ],
)
@pytest.mark.parametrize("folder", [False, True])
def test_language_markers_in_files_and_folders(simple, traditional, folder):
    names = (
        [f"Pack/{lang}/Example - 05 [1080p].mkv" for lang in [simple, traditional]]
        if folder
        else [f"Pack/Example - 05 [{lang}].mkv" for lang in [simple, traditional]]
    )
    files = [{"name": name, "index": index} for index, name in enumerate(names)]
    plan = build_plan(files, "番名", 2, RELEASE)
    assert plan["skip_file_ids"] == [1]
    assert len(plan["files"]) == 1
    assert plan["files"][0]["new"] == "Season 02/番名 S02E05.mkv"


def test_per_episode_fallback_and_dual_subtitles():
    names = [
        "Example - 01 [CHS].mkv",
        "Example - 01 [CHT].mkv",
        "Example - 02 [CHS].mkv",
        "Example - 03 [CHS&CHT].mkv",
        "Example - 01 [CHS].ass",
        "Example - 01 [CHT].ass",
        "Example - 02 [CHS].ass",
        "README.txt",
    ]
    plan = build_plan([{"name": n} for n in names], "番名", 1, RELEASE)
    assert plan["skip_file_ids"] == [1, 5]
    assert len(plan["files"]) == 6


@pytest.mark.parametrize(
    "languages,chosen",
    [
        (["CHS", "CHT"], "CHS"),
        (["CHS", "简繁内封", "CHT"], "CHS"),
        (["简繁内封", "CHT"], "简繁内封"),
        (["CHS&CHT", "CHT"], "CHS&CHT"),
        (["CHS", "CHS&CHT"], "CHS"),
        (["CHT"], "CHT"),
        (["简繁内封"], "简繁内封"),
    ],
)
@pytest.mark.parametrize("reverse", [False, True])
@pytest.mark.parametrize("episode_name", ["Example - 05", "video"])
def test_simplified_then_dual_then_traditional(languages, chosen, reverse, episode_name):
    languages = list(reversed(languages)) if reverse else languages
    files = [
        {"name": f"Pack/{episode_name} [{language}].mkv", "index": i}
        for i, language in enumerate(languages)
    ]
    plan = build_plan(files, "番名", 2, RELEASE)
    assert len(plan["files"]) == 1
    assert f"[{chosen}]" in plan["files"][0]["old"]
    assert plan["skip_file_ids"] == [i for i, lang in enumerate(languages) if lang != chosen]
    assert plan["selection_version"] == 2


def test_language_selection_does_not_guess_unknown_or_cross_seasons():
    names = [
        "A S01E01 [CHS].mkv",
        "A S02E01 [CHT].mkv",
        "Unmarked - 02.mkv",
        "Other - 03 [CHT].mkv",
        "SHOW_BIG.mkv",
    ]
    assert not language_preference([PurePosixPath(n) for n in names])


@pytest.mark.parametrize("running,old_endpoint", [(True, "resume"), (False, "pause")])
async def test_qbittorrent_four_start_stop_compatibility(running, old_endpoint):
    endpoints = []

    def handle(request):
        endpoint = request.url.path.rsplit("/", 1)[-1]
        endpoints.append(endpoint)
        return httpx.Response(200 if endpoint == old_endpoint else 404)

    async with httpx.AsyncClient(
        base_url="http://qb.test", transport=httpx.MockTransport(handle)
    ) as client:
        await download_queue.set_running(client, HASH, running)
    assert endpoints == ["start" if running else "stop", old_endpoint]
