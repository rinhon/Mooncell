import json
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import api, rss_service, subscription_settings
from app.api import router
from app.artwork_service import ArtworkResult
from app.database import Base, get_session
from app.dependencies import require_user
from app.models import (
    DomainEvent,
    DownloaderConfig,
    DownloadJob,
    FeedItem,
    FeedSource,
    ShowArtwork,
    ShowMetadata,
    User,
)
from app.schemas import TmdbMetadata


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
    app.dependency_overrides[require_user] = lambda: User(
        id=1, username="admin", password_hash="test",
    )
    yield app, sessions
    await engine.dispose()


async def test_edit_preserves_metadata_and_schedules_download_season_change(feed_edit_app):
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
        saved = next(f for f in feeds if f["id"] == 1)
        assert result["background_operation_ids"]
        saved.pop("background_operation_ids")
        result.pop("background_operation_ids")
        assert saved == result
    async with sessions() as session:
        source = await session.get(FeedSource, 1)
        assert source.etag is None and source.last_modified is None
        assert source.last_checked_at is None and source.last_error is None
        item = await session.get(FeedItem, 1)
        assert item.title == "已入库发布" and item.parse_status == "parsed"
        job = await session.get(DownloadJob, 1)
        assert (job.title, job.season, job.state) == ("修改后的番名", 0, "season_changing")
        migration = json.loads(job.plan)["season_change"]
        assert migration["previous_title"] == "原番名"
        assert migration["previous_season"] == 1
        assert migration["previous_plan"] == {"existing": True}
        assert json.loads(item.parse_data)["season"] == 0
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
    {"tmdb": {"tmdb_id": 0, "media_type": "tv"}},
    {"tmdb": {"tmdb_id": -1, "media_type": "tv"}},
    {"tmdb": {"tmdb_id": 1.5, "media_type": "tv"}},
    {"tmdb": {"tmdb_id": 123, "media_type": "invalid"}},
    {"tmdb": {"tmdb_id": 123}},
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


@pytest.fixture
async def tmdb_edit_app(feed_edit_app, monkeypatch, tmp_path):
    app, sessions = feed_edit_app

    async def scrape(tmdb_id, media_type):
        return TmdbMetadata(
            tmdb_id=tmdb_id, media_type=media_type, title="更新后的 TMDB 标题",
            episode_count=24, href=f"https://example.test/{media_type}/{tmdb_id}",
        )

    monkeypatch.setattr(api, "SessionFactory", sessions)
    monkeypatch.setattr(api, "get_library_root", AsyncMock(return_value=str(tmp_path)))
    monkeypatch.setattr(api, "scrape_tmdb", AsyncMock(side_effect=scrape))
    poster = tmp_path / "poster.jpg"
    poster.write_bytes(b"test-image")
    monkeypatch.setattr(api, "scrape_and_store_artwork", AsyncMock(return_value=ArtworkResult(
        directory=str(tmp_path), poster_path=str(poster), fanart_path=None,
        clearlogo_path=None, status="partial", error="缺少图片", scraped_at=datetime.now(UTC),
    )))
    return app, sessions


@pytest.mark.parametrize("source_id, tmdb_id, media_type", [
    (1, 456, "tv"), (1, 123, "movie"), (2, 789, "tv"),
])
async def test_edit_tmdb_updates_metadata_and_artwork(
    tmdb_edit_app, source_id, tmdb_id, media_type,
):
    app, sessions = tmdb_edit_app
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as c:
        response = await c.patch(f"/api/v1/feeds/{source_id}", json={
            "tmdb": {"tmdb_id": tmdb_id, "media_type": media_type},
        })
        assert response.status_code == 200
        assert response.json()["show_metadata"]["tmdb_id"] == tmdb_id
        assert response.json()["show_metadata"]["media_type"] == media_type
    api.scrape_tmdb.assert_awaited_once_with(tmdb_id, media_type)
    async with sessions() as session:
        source = await session.get(FeedSource, source_id)
        assert source.show_metadata.title == "更新后的 TMDB 标题"
        assert source.show_metadata.episode_count == 24
        assert source.artwork.status == "partial"
        assert source.artwork.poster_path.endswith("poster.jpg")
        job = await session.get(DownloadJob, 1)
        assert (job.title, job.season, job.state) == ("原番名", 1, "done")


async def test_same_tmdb_does_not_scrape_again(tmdb_edit_app):
    app, sessions = tmdb_edit_app
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as c:
        response = await c.patch("/api/v1/feeds/1", json={
            "tmdb": {"tmdb_id": 123, "media_type": "tv"}, "active": False,
        })
        assert response.status_code == 200
        assert response.json()["show_metadata"]["title"] == "元数据名称"
    api.scrape_tmdb.assert_not_awaited()


async def test_clear_tmdb_preserves_artwork(tmdb_edit_app):
    app, sessions = tmdb_edit_app
    async with sessions() as session:
        source = await session.get(FeedSource, 1)
        source.artwork = ShowArtwork(directory="/library", poster_path="poster.jpg")
        await session.commit()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as c:
        response = await c.patch("/api/v1/feeds/1", json={"tmdb": None})
        assert response.status_code == 200
        assert response.json()["show_metadata"] is None
    api.scrape_tmdb.assert_not_awaited()
    async with sessions() as session:
        source = await session.get(FeedSource, 1)
        assert source.show_metadata is None
        assert source.artwork.poster_path == "poster.jpg"


async def test_tmdb_failure_keeps_new_association(tmdb_edit_app, monkeypatch):
    app, sessions = tmdb_edit_app
    monkeypatch.setattr(api, "scrape_tmdb", AsyncMock(side_effect=RuntimeError("TMDB 离线")))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as c:
        response = await c.patch("/api/v1/feeds/1", json={
            "tmdb": {"tmdb_id": 456, "media_type": "tv"},
        })
        assert response.status_code == 200
    async with sessions() as session:
        source = await session.get(FeedSource, 1)
        assert source.show_metadata.tmdb_id == 456
        assert "TMDB 离线" in source.artwork.last_error


@pytest.mark.parametrize("replacement", [None, 999])
async def test_old_scrape_does_not_overwrite_edited_tmdb(tmdb_edit_app, monkeypatch, replacement):
    app, sessions = tmdb_edit_app
    original_scrape = api.scrape_tmdb

    async def edit_during_scrape(tmdb_id, media_type):
        async with sessions() as session:
            source = await session.get(FeedSource, 1)
            if replacement is None:
                source.show_metadata = None
            else:
                source.show_metadata.tmdb_id = replacement
                source.show_metadata.title = "新关联"
            await session.commit()
        return await original_scrape(tmdb_id, media_type)

    monkeypatch.setattr(api, "scrape_tmdb", edit_during_scrape)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as c:
        response = await c.patch("/api/v1/feeds/1", json={
            "tmdb": {"tmdb_id": 456, "media_type": "tv"},
        })
        assert response.status_code == 200
    async with sessions() as session:
        source = await session.get(FeedSource, 1)
        if replacement is None:
            assert source.show_metadata is None
        else:
            assert source.show_metadata.tmdb_id == replacement
            assert source.show_metadata.title == "新关联"
