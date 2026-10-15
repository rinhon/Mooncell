import json

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import api, download_queue, review
from app.database import Base, get_session
from app.dependencies import require_user
from app.download_queue import build_plan
from app.models import DomainEvent, DownloaderConfig, DownloadJob, FeedItem, FeedSource
from app.release_parser import parse_release_title
from app.schemas import ParsedRelease

HASH = "a" * 40
CORRECTION = {"title": "修正番名", "season": 0, "episode": 4.5}


@pytest.fixture
async def context():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as session:
        source = FeedSource(name="番名", season=2, url="https://example.test/rss")
        session.add(source)
        await session.flush()
        session.add(FeedItem(source_id=source.id, title="Example SP", fingerprint="one",
                             download_url=f"magnet:?xt=urn:btih:{HASH}",
                             parse_status="needs_review",
                             parse_data=parse_release_title("Example SP").model_dump_json()))
        await session.commit()

    async def session_override():
        async with sessions() as session:
            yield session

    app = FastAPI()
    app.include_router(api.router)
    app.include_router(review.router)
    app.dependency_overrides[get_session] = session_override
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                 base_url="http://test") as client:
        yield app, client, sessions
    await engine.dispose()


async def authorize(context):
    app, client, sessions = context
    app.dependency_overrides[require_user] = lambda: object()
    return client, sessions


async def add_downloader(sessions, job=False):
    async with sessions() as session:
        config = DownloaderConfig(name="qB", kind="qbittorrent", base_url="http://qb.test")
        session.add(config)
        await session.flush()
        if job:
            session.add(DownloadJob(item_id=1, info_hash=HASH, downloader_id=config.id,
                                    state="needs_review", target_root="/media",
                                    title="番名", season=2, last_error="文件集数未知"))
        await session.commit()


def mock_files(monkeypatch, files, fail=False):
    original = httpx.AsyncClient
    calls = []

    def handle(request):
        endpoint = request.url.path.rsplit("/", 1)[-1]
        calls.append(endpoint)
        if fail:
            return httpx.Response(503)
        if endpoint == "login":
            return httpx.Response(200, text="Ok.")
        if endpoint == "files":
            return httpx.Response(200, json=files)
        return httpx.Response(200)

    monkeypatch.setattr(review.httpx, "AsyncClient", lambda **kwargs: original(
        transport=httpx.MockTransport(handle), **kwargs))
    return calls


async def test_authentication_required(context):
    _, client, _ = context
    for path in ["", "/1/files"]:
        assert (await client.get("/api/v1/review" + path)).status_code == 401
    for action in ["approve", "ignore", "reparse"]:
        assert (await client.post(f"/api/v1/review/1/{action}",
                                  json=CORRECTION)).status_code == 401


async def test_reparse_stays_pending_ignore_persists_and_blocks_repeat(context):
    client, sessions = await authorize(context)
    assert len((await client.get("/api/v1/review")).json()) == 1
    assert (await client.get("/api/v1/downloads")).json()["tasks"][0]["review_required"]
    assert (await client.post("/api/v1/review/1/reparse")).status_code == 200
    assert len((await client.get("/api/v1/review")).json()) == 1
    assert (await client.post("/api/v1/review/1/ignore")).status_code == 200
    assert (await client.get("/api/v1/review")).json() == []
    assert not (await client.get("/api/v1/downloads")).json()["tasks"][0]["review_required"]
    assert (await client.post("/api/v1/review/1/approve", json=CORRECTION)).status_code == 409
    assert (await client.post("/api/v1/review/999/ignore")).status_code == 404
    async with sessions() as session:
        assert (await session.get(FeedItem, 1)).parse_status == "ignored"
        events = list(await session.scalars(select(DomainEvent)))
        assert [e.event_type for e in events] == ["review.reparsed", "review.ignored"]


@pytest.mark.parametrize("configured", [False, True])
async def test_approval_persists_item_corrections_and_enqueues_later(context, configured):
    client, sessions = await authorize(context)
    if configured:
        await add_downloader(sessions)
    response = await client.post("/api/v1/review/1/approve", json=CORRECTION)
    assert response.status_code == 200, response.text
    assert (await client.get("/api/v1/review")).json() == []
    if not configured:
        await add_downloader(sessions)
    async with sessions() as session:
        await download_queue.enqueue_source(session, await session.get(FeedSource, 1))
        await session.commit()
        job = await session.scalar(select(DownloadJob))
        assert job.title == "修正番名" and job.season == 0
        parsed = ParsedRelease.model_validate_json((await session.get(FeedItem, 1)).parse_data)
        assert parsed.episode_start == 4.5 and "manual_review" in parsed.evidence
        plan = build_plan([{"name": "Example SP.mkv"}], job.title, job.season, parsed)
        assert plan["files"][0]["new"] == "修正番名 S00E4.5.mkv"
        event = await session.scalar(select(DomainEvent))
        assert json.loads(event.payload)["before"]["episode_start"] is None


@pytest.mark.parametrize("body", [
    {**CORRECTION, "episode": -1}, {**CORRECTION, "season": 100},
    {**CORRECTION, "title": "../bad"}, {**CORRECTION, "title": " "},
    {**CORRECTION, "episode": None},
])
async def test_invalid_approval_does_not_change_item(context, body):
    client, sessions = await authorize(context)
    assert (await client.post("/api/v1/review/1/approve", json=body)).status_code == 422
    async with sessions() as session:
        assert (await session.get(FeedItem, 1)).parse_status == "needs_review"
        assert await session.scalar(select(DomainEvent)) is None


async def test_job_review_file_corrections_and_skip(context, monkeypatch):
    client, sessions = await authorize(context)
    await add_downloader(sessions, job=True)
    async with sessions() as session:
        (await session.get(FeedItem, 1)).parse_status = "parsed"
        (await session.scalar(select(DownloadJob))).plan = json.dumps({"show_tag": "番名"})
        await session.commit()
    files = [{"name": "Batch/a.mkv", "index": 4}, {"name": "Batch/b.mkv", "index": 9}]
    calls = mock_files(monkeypatch, files)
    assert len((await client.get("/api/v1/review")).json()) == 1
    assert (await client.get("/api/v1/dashboard")).json()["needs_review"] == 1
    assert len((await client.get("/api/v1/review/1/files")).json()) == 2
    response = await client.post("/api/v1/review/1/approve", json={**CORRECTION, "files": [
        {"name": "Batch/a.mkv", "episode": 8}, {"name": "Batch/b.mkv", "episode": None},
    ]})
    assert response.status_code == 200, response.text
    assert "stop" in calls
    async with sessions() as session:
        job = await session.scalar(select(DownloadJob))
        assert job.state == "organizing" and job.last_error is None
        plan = json.loads(job.plan)
        assert plan["skip_file_ids"] == [9]
        assert plan["files"][0]["new"] == "Season 00/修正番名 S00E08.mkv"
        assert plan["show_tag"] == "番名"  # 后台确认新标签后才移除这个旧标签。


async def test_file_collisions_stale_files_and_all_skipped_rejected(context, monkeypatch):
    client, sessions = await authorize(context)
    await add_downloader(sessions, job=True)
    mock_files(monkeypatch, [{"name": "a.mkv"}, {"name": "b.mkv"}])
    for names, episodes in [(["a.mkv", "b.mkv"], [1, 1]),
                            (["a.mkv", "b.mkv"], [None, None]),
                            (["old.mkv", "b.mkv"], [1, 2])]:
        response = await client.post("/api/v1/review/1/approve", json={**CORRECTION,
            "files": [{"name": name, "episode": ep}
                      for name, ep in zip(names, episodes, strict=True)]})
        assert response.status_code == 422, response.text
    async with sessions() as session:
        assert (await session.scalar(select(DownloadJob))).state == "needs_review"
        assert (await session.get(FeedItem, 1)).parse_status == "needs_review"


async def test_ignore_pauses_job_and_network_failure_preserves_review(context, monkeypatch):
    client, sessions = await authorize(context)
    await add_downloader(sessions, job=True)
    calls = mock_files(monkeypatch, [])
    assert (await client.post("/api/v1/review/1/ignore")).status_code == 200
    assert "stop" in calls
    assert "files" not in calls
    async with sessions() as session:
        assert (await session.scalar(select(DownloadJob))).state == "ignored"


async def test_unavailable_downloader_does_not_approve(context, monkeypatch):
    client, sessions = await authorize(context)
    await add_downloader(sessions, job=True)
    mock_files(monkeypatch, [], fail=True)
    assert (await client.post("/api/v1/review/1/approve", json=CORRECTION)).status_code == 502
    async with sessions() as session:
        assert (await session.scalar(select(DownloadJob))).state == "needs_review"
