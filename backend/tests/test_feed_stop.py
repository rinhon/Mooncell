import asyncio
import json
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import download_queue, rss_service, subscription_settings
from app.api import router
from app.database import Base, get_session
from app.dependencies import require_user
from app.models import (
    DomainEvent,
    DownloaderConfig,
    DownloadJob,
    FeedItem,
    FeedSource,
    LibrarySettings,
    ShowArtwork,
    ShowMetadata,
    User,
)
from app.release_parser import parse_release_title

HASH = "a" * 40
RELEASE = parse_release_title("[Group] Example - 01 [1080p]")
RSS = b"""<rss version="2.0"><channel><title>Example</title><item>
<title>[Group] Example - 02 [1080p]</title><guid>new-release</guid>
<enclosure url="magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" />
</item></channel></rss>"""


@pytest.fixture
async def stop_client(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'stop.db'}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    media = tmp_path / "library" / "Example S01E01.mkv"
    media.parent.mkdir()
    media.write_bytes(b"existing media")
    async with sessions() as session:
        source = FeedSource(
            id=1,
            name="Example",
            url="https://example.test/rss/1",
            kind="mikan",
            season=1,
            connection_status="healthy",
            etag="saved-etag",
        )
        source.show_metadata = ShowMetadata(
            tmdb_id=1,
            media_type="tv",
            title="Example",
            href="https://example.test/metadata/1",
        )
        source.artwork = ShowArtwork(directory=str(media.parent), status="completed")
        session.add_all(
            [
                source,
                FeedSource(id=2, name="Second", url="https://example.test/rss/2"),
                FeedSource(id=3, name="Stopped", url="https://example.test/rss/3", active=False),
                FeedSource(
                    id=4, name="Collection", url=f"magnet:?xt=urn:btih:{HASH}", kind="magnet"
                ),
                DownloaderConfig(id=1, name="qB", kind="qbittorrent", base_url="http://qb.test"),
                LibrarySettings(id=1, library_root=str(media.parent)),
                User(id=1, username="admin", password_hash="test"),
            ]
        )
        await session.flush()
        session.add(
            FeedItem(
                id=1,
                source_id=1,
                title=RELEASE.raw_title,
                download_url=f"magnet:?xt=urn:btih:{HASH}",
                fingerprint="existing",
                parse_data=RELEASE.model_dump_json(),
            )
        )
        await session.flush()
        session.add(
            DownloadJob(
                id=1,
                item_id=1,
                info_hash=HASH,
                downloader_id=1,
                target_root=str(media.parent),
                title="Example",
                season=1,
                state="queued",
                plan='{"existing": true}',
            )
        )
        await session.commit()

    async def session_override():
        async with sessions() as session:
            yield session

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_session] = session_override
    app.dependency_overrides[require_user] = lambda: User(id=1)
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            yield client, sessions, app, media
    finally:
        await engine.dispose()


async def test_stop_is_persistent_idempotent_and_preserves_subscription_data(stop_client):
    client, sessions, _app, media = stop_client
    for _ in range(2):
        response = await client.post("/api/v1/feeds/1/stop")
        assert response.status_code == 200
        assert response.json()["id"] == 1 and response.json()["active"] is False
        assert response.json()["show_metadata"]["tmdb_id"] == 1
    saved = next(item for item in (await client.get("/api/v1/feeds")).json() if item["id"] == 1)
    assert saved["active"] is False and saved["connection_status"] == "healthy"
    async with sessions() as session:
        source = await session.get(FeedSource, 1)
        assert source.url == "https://example.test/rss/1" and source.etag == "saved-etag"
        assert source.show_metadata.title == "Example" and source.artwork.status == "completed"
        assert (await session.get(FeedItem, 1)).fingerprint == "existing"
        job = await session.get(DownloadJob, 1)
        assert (job.item_id, job.state, job.plan) == (1, "queued", '{"existing": true}')
        events = list(
            await session.scalars(
                select(DomainEvent).where(DomainEvent.event_type == "feed.updated")
            )
        )
        assert len(events) == 1 and json.loads(events[0].payload)["active"] is False
    assert media.read_bytes() == b"existing media"
    restored = await client.patch("/api/v1/feeds/1", json={"active": True})
    assert restored.status_code == 200 and restored.json()["active"] is True


async def test_batch_stop_deduplicates_preserves_order_and_counts_existing_stops(stop_client):
    client, sessions, _app, _media = stop_client
    response = await client.post("/api/v1/feeds/batch-stop", json={"source_ids": [3, 2, 1, 2, 4]})
    assert response.status_code == 200
    result = response.json()
    assert [item["id"] for item in result["items"]] == [3, 2, 1, 4]
    assert all(item["active"] is False for item in result["items"])
    assert result["stopped_count"] == 3 and result["already_stopped_count"] == 1
    repeated = await client.post("/api/v1/feeds/batch-stop", json={"source_ids": [3, 2, 1, 4]})
    assert repeated.status_code == 200
    assert repeated.json()["stopped_count"] == 0
    assert repeated.json()["already_stopped_count"] == 4
    async with sessions() as session:
        assert (
            await session.scalar(
                select(func.count(DomainEvent.id)).where(DomainEvent.event_type == "feed.updated")
            )
            == 3
        )


@pytest.mark.parametrize(
    ("path", "body"),
    [
        ("/api/v1/feeds/999/stop", None),
        ("/api/v1/feeds/batch-stop", {"source_ids": [1, 999, 2]}),
    ],
)
async def test_missing_subscription_does_not_stop_any_requested_source(stop_client, path, body):
    client, sessions, _app, _media = stop_client
    response = await client.post(path, json=body)
    assert response.status_code == 404
    assert response.json()["detail"]["source_ids"] == [999]
    async with sessions() as session:
        assert (await session.get(FeedSource, 1)).active
        assert (await session.get(FeedSource, 2)).active
        assert await session.scalar(select(func.count(DomainEvent.id))) == 0


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"source_ids": []},
        {"source_ids": None},
        {"source_ids": [0]},
        {"source_ids": [-1]},
        {"source_ids": [True]},
        {"source_ids": [1.0]},
        {"source_ids": ["1"]},
        {"source_ids": list(range(1, 102))},
    ],
)
async def test_batch_stop_rejects_invalid_ids_without_mutation(stop_client, body):
    client, sessions, _app, _media = stop_client
    assert (await client.post("/api/v1/feeds/batch-stop", json=body)).status_code == 422
    async with sessions() as session:
        assert (await session.get(FeedSource, 1)).active
        assert await session.scalar(select(func.count(DomainEvent.id))) == 0


async def test_stop_endpoints_require_login(stop_client):
    client, sessions, app, _media = stop_client
    del app.dependency_overrides[require_user]
    assert (await client.post("/api/v1/feeds/1/stop")).status_code == 401
    assert (
        await client.post("/api/v1/feeds/batch-stop", json={"source_ids": [1, 2]})
    ).status_code == 401
    async with sessions() as session:
        assert (await session.get(FeedSource, 1)).active
        assert (await session.get(FeedSource, 2)).active


async def test_stopped_subscription_is_not_scheduled_or_manually_refreshed(
    stop_client, monkeypatch
):
    client, sessions, _app, _media = stop_client
    assert (
        await client.post("/api/v1/feeds/batch-stop", json={"source_ids": [1, 2]})
    ).status_code == 200
    refresh = AsyncMock()
    monkeypatch.setattr(subscription_settings, "SessionFactory", sessions)
    with monkeypatch.context() as patch:
        patch.setattr(rss_service.FeedRefreshService, "refresh", refresh)
        await subscription_settings.refresh_due_feeds()
    refresh.assert_not_awaited()
    response = await client.post("/api/v1/feeds/1/refresh")
    assert response.status_code == 409 and "停止" in response.json()["detail"]
    async with sessions() as session:
        assert (await session.get(FeedSource, 1)).connection_status == "healthy"
        assert (
            await session.scalar(
                select(func.count(DomainEvent.id)).where(
                    DomainEvent.event_type == "feed.refresh.failed"
                )
            )
            == 0
        )


@pytest.mark.parametrize("response_status", [200, 304])
async def test_stop_during_rss_request_discards_response(stop_client, monkeypatch, response_status):
    client, sessions, _app, _media = stop_client
    entered = asyncio.Event()
    release = asyncio.Event()
    original_client = httpx.AsyncClient

    async def transport(request):
        entered.set()
        await release.wait()
        return httpx.Response(response_status, content=RSS if response_status == 200 else b"")

    monkeypatch.setattr(
        rss_service.httpx,
        "AsyncClient",
        lambda **kwargs: original_client(transport=httpx.MockTransport(transport)),
    )
    async with sessions() as session:
        source = await session.get(FeedSource, 1)
        task = asyncio.create_task(rss_service.FeedRefreshService(session).refresh(source))
        try:
            await asyncio.wait_for(entered.wait(), 2)
            response = await asyncio.wait_for(client.post("/api/v1/feeds/1/stop"), 2)
            assert response.status_code == 200
        finally:
            release.set()
            outcome = (await asyncio.gather(task, return_exceptions=True))[0]
        assert isinstance(outcome, rss_service.FeedStoppedError), outcome
    async with sessions() as session:
        source = await session.get(FeedSource, 1)
        assert source.active is False and source.connection_status == "healthy"
        assert source.last_checked_at is None and source.etag == "saved-etag"
        assert await session.scalar(select(func.count(FeedItem.id))) == 1
        assert await session.scalar(select(func.count(DownloadJob.id))) == 1
        assert (
            await session.scalar(
                select(func.count(DomainEvent.id)).where(
                    DomainEvent.event_type.in_(["feed.refresh.failed", "download.failed"])
                )
            )
            == 0
        )


async def test_enqueue_rechecks_stopped_source_instead_of_using_old_orm_state(
    stop_client, monkeypatch
):
    client, sessions, _app, _media = stop_client
    enqueue = AsyncMock()
    monkeypatch.setattr(download_queue, "enqueue_source", enqueue)
    async with sessions() as session:
        source = await session.get(FeedSource, 1)
        await session.commit()
        assert source.active is True
        assert (await client.post("/api/v1/feeds/1/stop")).status_code == 200
        assert source.active is True
        try:
            await rss_service.FeedRefreshService(session)._enqueue_downloads(source)
        except rss_service.FeedStoppedError:
            pass
        enqueue.assert_not_awaited()
    async with sessions() as session:
        assert await session.scalar(select(func.count(DownloadJob.id))) == 1
        assert (
            await session.scalar(
                select(func.count(DomainEvent.id)).where(
                    DomainEvent.event_type == "download.failed"
                )
            )
            == 0
        )
