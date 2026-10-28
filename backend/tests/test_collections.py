import asyncio
import json
from copy import deepcopy
from pathlib import PurePosixPath
from unittest.mock import AsyncMock
from urllib.parse import parse_qs

import httpx
import pytest
from sqlalchemy import func, select
from test_feed_creation import feed_app as feed_app

from app import collections, download_queue, subscription_settings
from app.collection_plan import build_collection_plan, collection_title
from app.models import BackgroundOperation, DownloaderConfig, DownloadJob, FeedItem, FeedSource
from app.release_parser import parse_release_title
from app.schemas import ParsedRelease

HASH = "5ff6dd449f7f2a37bc763a2c995648c0dad623d8"
MAGNET = f"magnet:?xt=urn:btih:{HASH}"
TITLE = "[LoliHouse] Otome Game Sekai wa Mob ni Kibishii Sekai desu 2"
ROOT = TITLE + " [01-12][WebRip 1080p HEVC-10bit AAC]"
INFO = {
    "name": ROOT,
    "length": 2400,
    "files": [
        {
            "path": f"{ROOT}/{TITLE} - {episode:02d} [WebRip 1080p HEVC-10bit AAC SRTx2].mkv",
            "length": 100,
        }
        for episode in range(1, 13)
    ],
}
VALUES = {
    "magnet": MAGNET,
    "name": "路人角色的世界",
    "season": 2,
    "tmdb": {"tmdb_id": 123, "media_type": "tv"},
}


@pytest.fixture
async def collection_app(feed_app, monkeypatch, tmp_path):
    app, sessions = feed_app
    app.include_router(collections.router)
    monkeypatch.setattr(collections, "fetch_metadata", AsyncMock(return_value=deepcopy(INFO)))
    monkeypatch.setattr(collections, "get_library_root", AsyncMock(return_value=str(tmp_path)))
    return app, sessions


def test_real_lolihouse_layout_and_title():
    assert collection_title(ROOT) == ("Otome Game Sekai wa Mob ni Kibishii Sekai desu", 2)
    files = [{"name": f["path"]} for f in INFO["files"]]
    plan = build_collection_plan(files, "作品", 2, parse_release_title(ROOT))
    assert len(plan["files"]) == 12
    assert plan["files"][0]["new"] == "Season 02/作品 S02E01.mkv"
    assert plan["files"][-1]["new"] == "Season 02/作品 S02E12.mkv"
    assert plan["skip_file_ids"] == []


def test_dbd_layout_with_extras_and_external_subtitles():
    def name(episode):
        return f"[DBD-Raws][Basilisk Kouga Ninpou Chou][{episode:02d}][1080P][HEVC-10bit]"

    files = [
        {"name": f"Original/{name(ep)}{extension}"}
        for ep in range(1, 25)
        for extension in (".mkv", ".sc.ass", ".tc.ass")
    ]
    files += [
        {"name": f"Original/{folder}/{filename}"}
        for folder, filename in [
            ("Fonts", "Fonts.rar"),
            ("NCOP&NCED", "[DBD-Raws][NCOP][1080P].mkv"),
            ("menu", "[DBD-Raws][menu][01][1080P].mkv"),
            ("特典映像", "[DBD-Raws][Tokuten][01][480P].mkv"),
        ]
    ]
    plan = build_collection_plan(
        files, "甲贺忍法帖", 1, parse_release_title("[Group] Batch [01-24]")
    )
    targets = {f["new"] for f in plan["files"]}
    assert "Season 01/甲贺忍法帖 S01E01.mkv" in targets
    assert "Season 01/甲贺忍法帖 S01E01.zh-Hans.ass" in targets
    assert "Season 01/甲贺忍法帖 S01E24.zh-Hant.ass" in targets
    assert plan["skip_file_ids"] == [72, 73, 74, 75]


def test_manual_collection_episode_and_original_subtitles_use_standardized_names():
    files = [
        {"name": "Original/unidentified.mkv", "index": 0},
        {"name": "Original/unidentified.sc.ass", "index": 1},
        {"name": "Original/Show - 02.mkv", "index": 2},
    ]
    release = ParsedRelease.model_validate(
        {
            **parse_release_title(ROOT).model_dump(),
            "collection_file_overrides": [
                {"path": files[0]["name"], "episode": 0},
                {"path": files[2]["name"], "episode": 12.5},
            ],
        }
    )
    plan = build_collection_plan(files, "作品", 2, release)
    targets = {entry["old"]: entry["new"] for entry in plan["files"]}
    assert targets == {
        "Season 02/unidentified.mkv": "Season 02/作品 S02E00.mkv",
        "Season 02/unidentified.sc.ass": "Season 02/作品 S02E00.zh-Hans.ass",
        "Season 02/Show - 02.mkv": "Season 02/作品 S02E12.5.mkv",
    }
    assert plan["episodes"] == [0, 12.5]
    assert plan["skip_file_ids"] == []


def test_manual_collection_edits_identify_the_complete_original_path():
    files = [
        {"name": "Original/first/Show - 01.mkv"},
        {"name": "Original/second/Show - 01.mkv"},
    ]
    release = ParsedRelease.model_validate(
        {
            **parse_release_title(ROOT).model_dump(),
            "collection_file_overrides": [{"path": files[1]["name"], "episode": 2}],
        }
    )
    plan = build_collection_plan(files, "作品", 1, release)
    assert {entry["new"] for entry in plan["files"]} == {
        "Season 01/作品 S01E01.mkv",
        "Season 01/作品 S01E02.mkv",
    }


def test_standardized_collection_name_cannot_overlap_another_original_name():
    files = [
        {"name": "Original/First - 01.mkv"},
        {"name": "Original/作品 S01E02.mkv"},
    ]
    release = ParsedRelease.model_validate(
        {
            **parse_release_title(ROOT).model_dump(),
            "collection_file_overrides": [
                {"path": files[0]["name"], "episode": 2},
                {"path": files[1]["name"], "episode": 3},
            ],
        }
    )
    with pytest.raises(ValueError, match="原始文件冲突"):
        build_collection_plan(files, "作品", 1, release)


def test_legacy_collection_filenames_do_not_override_standardized_names():
    files = [
        {"name": "Original/A - 01.mkv"},
        {"name": "Original/B - 02.mkv"},
    ]
    release = ParsedRelease.model_validate(
        {
            **parse_release_title(ROOT).model_dump(),
            "collection_file_overrides": [
                {"path": files[0]["name"], "episode": 4.5, "filename": "第一视角.mkv"},
                {"path": files[1]["name"], "filename": "第二视角.mkv"},
            ],
        }
    )
    plan = build_collection_plan(files, "作品", 1, release)
    assert {entry["new"] for entry in plan["files"]} == {
        "Season 01/作品 S01E4.5.mkv",
        "Season 01/作品 S01E02.mkv",
    }
    assert plan["episodes"] == [4.5, 2]
    assert plan["skip_file_ids"] == []


def test_legacy_filename_only_edit_is_ignored_even_if_original_file_is_gone():
    files = [{"name": "Original/A - 01.mkv"}]
    release = ParsedRelease.model_validate(
        {
            **parse_release_title(ROOT).model_dump(),
            "collection_file_overrides": [
                {"path": "Original/missing.mkv", "filename": "旧自定义名称.mkv"},
            ],
        }
    )
    plan = build_collection_plan(files, "作品", 1, release)
    assert plan["files"] == [
        {
            "old": "Season 01/A - 01.mkv",
            "new": "Season 01/作品 S01E01.mkv",
        }
    ]


@pytest.mark.parametrize(
    "names, message",
    [
        (["Original/a.mkv", "Original/b.mkv"], "集数"),
        (["Original/A - 01.mkv", "Original/B - 01.mkv"], "冲突"),
        (["../A - 01.mkv"], "无效"),
        (["C:/A - 01.mkv"], "无效"),
        (["Original/all-episodes.mkv"], "集数"),
    ],
)
def test_unsafe_layout_cannot_start(names, message):
    with pytest.raises(ValueError, match=message):
        build_collection_plan([{"name": n} for n in names], "作品", 1, parse_release_title(ROOT))


async def test_inspect_pending_then_original_files_and_no_download(collection_app):
    app, sessions = collection_app
    collections.fetch_metadata.side_effect = [None, deepcopy(INFO)]
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as c:
        pending = await c.post("/api/v1/collections/inspect", json={"magnet": MAGNET})
        assert pending.json()["status"] == "pending"
        ready = await c.post("/api/v1/collections/inspect", json={"magnet": MAGNET})
        assert ready.json()["raw_title"] == ROOT
        assert ready.json()["season"] == 2
        assert len(ready.json()["files"]) == 12
        assert ready.json()["files"][-1]["episode"] == 12
    async with sessions() as session:
        assert await session.scalar(select(func.count(FeedSource.id))) == 0
        assert await session.scalar(select(func.count(DownloadJob.id))) == 0


async def test_create_scrapes_and_enqueues_once_without_rss_refresh(collection_app, monkeypatch):
    app, sessions = collection_app
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as c:
        saved = await c.post("/api/v1/collections", json=VALUES)
        assert saved.status_code == 201, saved.text
        source_id = saved.json()["id"]
        assert saved.json()["kind"] == "magnet"
        assert saved.json()["show_metadata"]["tmdb_id"] == 123
        duplicate = await c.post(
            "/api/v1/collections", json={**VALUES, "magnet": MAGNET + "&dn=other"}
        )
        assert duplicate.status_code == 409
        assert (await c.post(f"/api/v1/feeds/{source_id}/refresh")).status_code == 409
        # 合集编辑保留磁力类型，不走 RSS URL 验证。
        edited = await c.patch(f"/api/v1/feeds/{source_id}", json={"active": False})
        assert edited.status_code == 200
    async with sessions() as session:
        source = await session.get(FeedSource, source_id)
        assert source.show_metadata.episode_count == 12
        assert source.artwork.status == "completed"
        assert source.url == MAGNET
        job = await session.scalar(select(DownloadJob))
        assert job.info_hash == HASH and job.season == 2 and job.state == "queued"
        item = await session.get(FeedItem, job.item_id)
        assert "magnet_collection" in json.loads(item.parse_data)["evidence"]
        notices = list(
            await session.scalars(
                select(BackgroundOperation).where(
                    BackgroundOperation.kind == "download_added",
                )
            )
        )
        assert len(notices) == 1 and notices[0].source_id == source_id
        assert notices[0].attention_revision > notices[0].read_revision
        source.active = True
        await session.commit()
    monkeypatch.setattr(subscription_settings, "SessionFactory", sessions)
    from app import rss_service

    refresh = AsyncMock()
    monkeypatch.setattr(rss_service.FeedRefreshService, "refresh", refresh)
    await subscription_settings.refresh_due_feeds()
    refresh.assert_not_called()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as c:
        assert (await c.delete(f"/api/v1/feeds/{source_id}")).status_code == 200
    async with sessions() as session:
        assert await session.scalar(select(func.count(DownloadJob.id))) == 0
        assert await session.scalar(select(func.count(FeedItem.id))) == 0


async def test_invalid_or_unready_collection_has_no_side_effects(collection_app):
    app, sessions = collection_app
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as c:
        for patch in [
            {"magnet": "https://example.test"},
            {"name": " "},
            {"tmdb": {"tmdb_id": 123, "media_type": "movie"}},
        ]:
            assert (
                await c.post("/api/v1/collections", json={**VALUES, **patch})
            ).status_code == 422
        collections.fetch_metadata.return_value = None
        assert (await c.post("/api/v1/collections", json=VALUES)).status_code == 409
    async with sessions() as session:
        assert await session.scalar(select(func.count(FeedSource.id))) == 0


async def test_collection_file_edits_are_persisted_with_the_original_identity(collection_app):
    app, sessions = collection_app
    edits = [{"path": INFO["files"][0]["path"], "episode": 0}]
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as c:
        response = await c.post("/api/v1/collections", json={**VALUES, "file_overrides": edits})
        assert response.status_code == 201, response.text
    async with sessions() as session:
        item = await session.scalar(select(FeedItem))
        release = ParsedRelease.model_validate_json(item.parse_data)
        assert release.episode_start == 0 and release.episode_end == 12
        stored = [edit.model_dump(exclude_none=True) for edit in release.collection_file_overrides]
        assert stored == edits
        plan = build_collection_plan(
            [{"name": file["path"]} for file in INFO["files"]],
            VALUES["name"],
            2,
            release,
        )
        assert plan["files"][0]["new"] == f"Season 02/{VALUES['name']} S02E00.mkv"


async def test_collection_api_rejects_changes_to_original_filenames(collection_app):
    app, sessions = collection_app
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as c:
        response = await c.post(
            "/api/v1/collections",
            json={
                **VALUES,
                "file_overrides": [
                    {
                        "path": INFO["files"][0]["path"],
                        "episode": 4.5,
                        "filename": "合法名称.mkv",
                    }
                ],
            },
        )
        assert response.status_code == 422, response.text
        assert "原文件名" in response.text
    async with sessions() as session:
        for model in (FeedSource, FeedItem, DownloadJob):
            assert await session.scalar(select(func.count(model.id))) == 0


async def test_unrecognized_collection_video_can_be_confirmed_before_saving(collection_app):
    app, sessions = collection_app
    info = {**deepcopy(INFO), "files": [{"path": "Original/unidentified.mkv", "length": 100}]}
    collections.fetch_metadata.return_value = info
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as c:
        assert (await c.post("/api/v1/collections", json=VALUES)).status_code == 422
        response = await c.post(
            "/api/v1/collections",
            json={
                **VALUES,
                "file_overrides": [{"path": "Original/unidentified.mkv", "episode": 0}],
            },
        )
        assert response.status_code == 201, response.text
    async with sessions() as session:
        item = await session.scalar(select(FeedItem))
        release = ParsedRelease.model_validate_json(item.parse_data)
        assert release.episode_start == release.episode_end == 0


@pytest.mark.parametrize(
    "edits",
    [
        [{"path": "unknown/Show - 01.mkv", "episode": 4}],
        [{"path": PurePosixPath(INFO["files"][0]["path"]).name, "episode": 4}],
        [{"path": INFO["files"][0]["path"], "episode": 3}] * 2,
        [{"path": INFO["files"][0]["path"], "episode": -1}],
        [
            {"path": INFO["files"][0]["path"], "episode": 1},
            {"path": INFO["files"][1]["path"], "episode": 1},
        ],
    ],
)
async def test_invalid_collection_file_edits_have_no_side_effects(collection_app, edits):
    app, sessions = collection_app
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as c:
        response = await c.post("/api/v1/collections", json={**VALUES, "file_overrides": edits})
        assert response.status_code == 422, response.text
    async with sessions() as session:
        for model in (FeedSource, FeedItem, DownloadJob):
            assert await session.scalar(select(func.count(model.id))) == 0


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_collection_edits_reject_non_finite_episodes(value):
    with pytest.raises(ValueError):
        collections.CollectionCreate.model_validate(
            {
                **VALUES,
                "file_overrides": [{"path": INFO["files"][0]["path"], "episode": value}],
            }
        )


@pytest.mark.parametrize("path", ["Original/menu/[menu][01].mkv", "Original/readme.txt"])
async def test_collection_edits_cannot_promote_extras_or_attachments(collection_app, path):
    app, sessions = collection_app
    info = deepcopy(INFO)
    info["files"].append({"path": path, "length": 100})
    collections.fetch_metadata.return_value = info
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as c:
        response = await c.post(
            "/api/v1/collections",
            json={
                **VALUES,
                "file_overrides": [{"path": path, "episode": 13}],
            },
        )
        assert response.status_code == 422, response.text
    async with sessions() as session:
        assert await session.scalar(select(func.count(DownloadJob.id))) == 0


@pytest.mark.parametrize("edited", [False, True])
async def test_collection_queue_stops_selects_renames_and_resumes(
    collection_app,
    monkeypatch,
    edited,
):
    app, sessions = collection_app
    info = deepcopy(INFO)
    info["files"] = info["files"][:2] + [
        {"path": f"{ROOT}/menu/[menu][01].mkv", "length": 100},
        {"path": info["files"][0]["path"].removesuffix(".mkv") + ".sc.ass", "length": 100},
    ]
    collections.fetch_metadata.return_value = info
    edits = [{"path": info["files"][0]["path"], "episode": 4.5}]
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as c:
        response = await c.post(
            "/api/v1/collections",
            json={**VALUES, "file_overrides": edits if edited else []},
        )
        assert response.status_code == 201, response.text
    state = {
        "torrent": None,
        "files": [
            {"name": f["path"], "index": i, "priority": 1} for i, f in enumerate(info["files"])
        ],
    }
    calls = []
    failed_rename = False

    def handle(request):
        nonlocal failed_rename
        endpoint = request.url.path.rsplit("/", 1)[-1]
        data = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
        calls.append(endpoint)
        if endpoint == "login":
            return httpx.Response(200, text="Ok.")
        if endpoint == "info":
            return httpx.Response(200, json=[state["torrent"]] if state["torrent"] else [])
        if endpoint == "add":
            assert data["stopCondition"] == "MetadataReceived"
            state["torrent"] = {
                "save_path": data["savepath"],
                "state": "stoppedDL",
                "tags": VALUES["name"],
            }
            return httpx.Response(200, text="Ok.")
        if endpoint == "files":
            return httpx.Response(200, json=state["files"])
        if endpoint == "filePrio":
            assert data["id"] == "2" and data["priority"] == "0"
            state["files"][2]["priority"] = 0
        if endpoint == "renameFolder":
            for f in state["files"]:
                f["name"] = f["name"].replace(data["oldPath"] + "/", data["newPath"] + "/", 1)
        if endpoint == "renameFile":
            if edited and not failed_rename:
                failed_rename = True
                raise httpx.ReadTimeout("模拟整理中断", request=request)
            for f in state["files"]:
                if f["name"] == data["oldPath"]:
                    f["name"] = data["newPath"]
        if endpoint == "setLocation":
            state["torrent"]["save_path"] = data["location"]
        if endpoint == "start":
            assert state["files"][2]["priority"] == 0
            subtitle = "S02E4.5.zh-Hans.ass" if edited else "S02E01.zh-Hans.ass"
            assert state["files"][3]["name"].endswith(subtitle)
        return httpx.Response(200)

    client = httpx.AsyncClient
    monkeypatch.setattr(
        download_queue.httpx,
        "AsyncClient",
        lambda **kw: client(
            base_url="http://qb.test",
            transport=httpx.MockTransport(handle),
        ),
    )
    monkeypatch.setattr(download_queue, "SessionFactory", sessions)
    for _ in range(16):
        await download_queue.process_queue()
        if edited:
            async with sessions() as session:
                job = await session.scalar(select(DownloadJob))
                if job.next_retry_at is not None:
                    job.next_retry_at = None
                    await session.commit()
    assert calls.count("add") == calls.count("start") == 1
    async with sessions() as session:
        job = await session.scalar(select(DownloadJob))
        assert job.state == "done", job.last_error
        assert all(
            PurePosixPath(f["new"]).parent.name == "Season 02"
            for f in json.loads(job.plan)["files"]
        )
        if edited:
            assert failed_rename
            assert state["files"][0]["name"] == f"Season 02/{VALUES['name']} S02E4.5.mkv"
            item = await session.get(FeedItem, job.item_id)
            release = ParsedRelease.model_validate_json(item.parse_data)
            assert release.collection_file_overrides[0].episode == 4.5
            assert release.collection_file_overrides[0].filename is None


async def test_metadata_fetch_never_adds_torrent(monkeypatch):
    endpoints = []

    def handle(request):
        endpoints.append(request.url.path)
        if request.url.path.endswith("login"):
            return httpx.Response(200, text="Ok.")
        return httpx.Response(200, json={"hash": HASH, "info": INFO})

    client = httpx.AsyncClient
    monkeypatch.setattr(
        collections.httpx,
        "AsyncClient",
        lambda **kw: client(
            base_url="http://qb.test",
            transport=httpx.MockTransport(handle),
        ),
    )
    config = DownloaderConfig(base_url="http://qb.test", verify_tls=True)
    assert await collections.fetch_metadata(config, MAGNET) == INFO
    assert endpoints == ["/api/v2/auth/login", "/api/v2/torrents/fetchMetadata"]


@pytest.fixture
def metadata_transport(monkeypatch):
    # qB's metadata cache belongs to its authenticated WebUI session.
    monkeypatch.setattr(collections, "_metadata_sessions", {})
    client = httpx.AsyncClient

    def install(handler):
        monkeypatch.setattr(
            collections.httpx,
            "AsyncClient",
            lambda **kw: client(**kw, transport=httpx.MockTransport(handler)),
        )

    return install


async def test_metadata_polling_and_save_keep_the_same_qb_session(metadata_transport):
    logins = 0
    started = set()
    endpoints = []

    def handle(request):
        nonlocal logins
        endpoints.append(request.url.path)
        if request.url.path.endswith("login"):
            logins += 1
            return httpx.Response(
                200, text="Ok.", headers={"set-cookie": f"QBT_SID_8080=session-{logins}; Path=/"}
            )
        sid = request.headers.get("cookie")
        if sid not in started:
            started.add(sid)
            return httpx.Response(202, json={"infohash_v1": HASH})
        return httpx.Response(200, json={"infohash_v1": HASH, "info": INFO})

    metadata_transport(handle)
    config = DownloaderConfig(base_url="http://qb.test", verify_tls=True)
    assert await collections.fetch_metadata(config, MAGNET) is None
    assert await collections.fetch_metadata(config, MAGNET) == INFO
    # Saving a previously inspected collection must also see the cached metadata.
    assert await collections.fetch_metadata(config, MAGNET) == INFO
    assert logins == 1
    assert endpoints == ["/api/v2/auth/login"] + ["/api/v2/torrents/fetchMetadata"] * 3


@pytest.mark.parametrize("status", [401, 403])
async def test_metadata_reauthenticates_an_expired_session(metadata_transport, status):
    logins = 0
    rejected = 0

    def handle(request):
        nonlocal logins, rejected
        if request.url.path.endswith("login"):
            logins += 1
            return httpx.Response(
                200, text="Ok.", headers={"set-cookie": f"QBT_SID_8080=session-{logins}; Path=/"}
            )
        if request.headers.get("cookie") == "QBT_SID_8080=session-1":
            if rejected == 0:
                rejected += 1
                return httpx.Response(202, json={"infohash_v1": HASH})
            rejected += 1
            return httpx.Response(status)
        return httpx.Response(200, json={"infohash_v1": HASH, "info": INFO})

    metadata_transport(handle)
    config = DownloaderConfig(base_url="http://qb.test", verify_tls=True)
    assert await collections.fetch_metadata(config, MAGNET) is None
    assert await collections.fetch_metadata(config, MAGNET) == INFO
    assert logins == 2
    assert rejected == 2


async def test_metadata_sessions_are_separate_for_downloader_credentials(metadata_transport):
    logins = []

    def handle(request):
        if request.url.path.endswith("login"):
            logins.append(parse_qs(request.content.decode())["username"][0])
            return httpx.Response(
                200,
                text="Ok.",
                headers={"set-cookie": f"QBT_SID_8080=session-{len(logins)}; Path=/"},
            )
        return httpx.Response(200, json={"infohash_v1": HASH, "info": INFO})

    metadata_transport(handle)
    config = DownloaderConfig(base_url="http://qb.test", username="first", verify_tls=True)
    assert await collections.fetch_metadata(config, MAGNET) == INFO
    config.username = "second"
    assert await collections.fetch_metadata(config, MAGNET) == INFO
    assert logins == ["first", "second"]


async def test_concurrent_metadata_previews_share_one_login(metadata_transport):
    logins = 0

    async def handle(request):
        nonlocal logins
        if request.url.path.endswith("login"):
            logins += 1
            await asyncio.sleep(0)
            return httpx.Response(
                200, text="Ok.", headers={"set-cookie": "QBT_SID_8080=shared; Path=/"}
            )
        assert request.headers["cookie"] == "QBT_SID_8080=shared"
        return httpx.Response(200, json={"infohash_v1": HASH, "info": INFO})

    metadata_transport(handle)
    config = DownloaderConfig(base_url="http://qb.test", verify_tls=True)
    results = await asyncio.gather(
        collections.fetch_metadata(config, MAGNET), collections.fetch_metadata(config, MAGNET)
    )
    assert results == [INFO, INFO]
    assert logins == 1
