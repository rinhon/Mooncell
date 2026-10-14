from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import rss_service, subscription_settings
from app.api import router
from app.database import Base, get_session
from app.dependencies import require_user
from app.models import (
    DomainEvent,
    DownloaderConfig,
    DownloadJob,
    FeedItem,
    FeedSource,
    ShowMetadata,
)


@pytest.fixture
async def feed_edit_app():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as session:
        source = FeedSource(
            id=1, name="原番名", url="https://example.test/rss", kind="mikan", season=1,
            excluded_keywords=["720"], active=True, refresh_interval_minutes=5,
            etag="old-etag", last_modified="old-modified", last_checked_at=datetime.now(UTC),
            connection_status="healthy", last_error="旧错误",
        )
        source.show_metadata = ShowMetadata(tmdb_id=123, media_type="tv", title="元数据名称",
                                            href="https://example.test/metadata")
        session.add_all([
            source,
            FeedSource(id=2, name="另一订阅", url="https://example.test/taken"),
            DownloaderConfig(id=1, name="qB", kind="qbittorrent", base_url="http://qb.test"),
        ])
        await session.flush()
        session.add(FeedItem(id=1, source_id=1, title="已入库发布", fingerprint="first",
                             download_url="magnet:?xt=urn:btih:" + "a" * 40,
                             parse_data="{}"))
        await session.flush()
        session.add(DownloadJob(id=1, item_id=1, info_hash="a" * 40, downloader_id=1,
                                target_root="/library", title="原番名", season=1, state="done",
                                plan='{"existing": true}'))
        await session.commit()

    async def session_override():
        async with sessions() as session:
            yield session

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_session] = session_override
    app.dependency_overrides[require_user] = lambda: object()
    yield app, sessions
    await engine.dispose()


async def test_edit_persists_fields_and_preserves_metadata_and_download(feed_edit_app):
    app, sessions = feed_edit_app
    values = {
        "name": " 修改后的番名 ", "url": "https://example.test/new-rss", "kind": "standard",
        "season": 0, "excluded_keywords": [" 繁 ", " RAW ", "raw", ""],
        "active": False, "refresh_interval_minutes": 30,
    }
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as c:
        response = await c.patch("/api/v1/feeds/1", json=values)
        assert response.status_code == 200
        result = response.json()
        assert result["name"] == "修改后的番名"
        assert result["excluded_keywords"] == ["繁", "RAW"]
        for key in ("url", "kind", "season", "active", "refresh_interval_minutes"):
            assert result[key] == values[key]
        assert result["show_metadata"]["tmdb_id"] == 123
        assert result["connection_status"] == "unknown"
        feeds = (await c.get("/api/v1/feeds")).json()
        assert next(f for f in feeds if f["id"] == 1) == result
    async with sessions() as session:
        source = await session.get(FeedSource, 1)
        assert source.etag is None and source.last_modified is None
        assert source.last_checked_at is None and source.last_error is None
        item = await session.get(FeedItem, 1)
        assert item.title == "已入库发布" and item.parse_status == "parsed"
        job = await session.get(DownloadJob, 1)
        assert (job.title, job.season, job.state) == ("原番名", 1, "done")
        assert job.plan == '{"existing": true}'
        assert await session.scalar(select(DomainEvent).where(
            DomainEvent.event_type == "feed.updated",
        )) is not None


async def test_partial_edit_and_clear_optional_fields(feed_edit_app):
    app, sessions = feed_edit_app
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as c:
        response = await c.patch("/api/v1/feeds/1", json={"active": False})
        assert response.status_code == 200
        assert response.json()["excluded_keywords"] == ["720"]
        async with sessions() as session:
            assert (await session.get(FeedSource, 1)).etag == "old-etag"
        response = await c.patch("/api/v1/feeds/1", json={"season": None, "excluded_keywords": []})
        assert response.status_code == 200
        assert response.json()["season"] is None
        assert response.json()["excluded_keywords"] == []
        assert response.json()["name"] == "原番名"
        async with sessions() as session:
            assert (await session.get(FeedSource, 1)).etag is None


@pytest.mark.parametrize("values", [
    {"name": None}, {"name": "   "}, {"url": None}, {"url": "ftp://example.test/rss"},
    {"kind": None}, {"kind": "invalid"}, {"active": None}, {"excluded_keywords": None},
    {"excluded_keywords": ["x" * 101]}, {"excluded_keywords": [str(i) for i in range(21)]},
    {"refresh_interval_minutes": None}, {"refresh_interval_minutes": 0},
    {"refresh_interval_minutes": 1441}, {"season": -1},
])
async def test_invalid_edit_does_not_modify_subscription(feed_edit_app, values):
    app, sessions = feed_edit_app
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as c:
        response = await c.patch("/api/v1/feeds/1", json=values)
        assert response.status_code == 422
    async with sessions() as session:
        source = await session.get(FeedSource, 1)
        assert source.name == "原番名"
        assert source.excluded_keywords == ["720"]
        assert source.etag == "old-etag"


async def test_duplicate_url_and_missing_subscription(feed_edit_app):
    app, sessions = feed_edit_app
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as c:
        response = await c.patch("/api/v1/feeds/1", json={"url": "https://example.test/taken"})
        assert response.status_code == 409
        assert (await c.patch("/api/v1/feeds/999", json={"name": "missing"})).status_code == 404
    async with sessions() as session:
        assert (await session.get(FeedSource, 1)).url == "https://example.test/rss"


async def test_scheduler_uses_edited_subscription_interval(feed_edit_app, monkeypatch):
    app, sessions = feed_edit_app
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as c:
        for source_id, interval in [(1, 2), (2, 30)]:
            response = await c.patch(f"/api/v1/feeds/{source_id}",
                                     json={"refresh_interval_minutes": interval})
            assert response.status_code == 200
    async with sessions() as session:
        for source in await session.scalars(select(FeedSource)):
            source.last_checked_at = datetime.now(UTC) - timedelta(minutes=3)
        await session.commit()
    refresh = AsyncMock()
    monkeypatch.setattr(subscription_settings, "SessionFactory", sessions)
    monkeypatch.setattr(rss_service.FeedRefreshService, "refresh", refresh)
    await subscription_settings.refresh_due_feeds()
    refresh.assert_awaited_once()
    assert refresh.call_args.args[0].id == 1
