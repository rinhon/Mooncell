import asyncio
import json
from datetime import UTC, datetime
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import api
from app.artwork_service import ArtworkResult
from app.database import Base, get_session
from app.dependencies import require_user
from app.events import broker, event_log_fields
from app.models import DomainEvent, DownloaderConfig, FeedSource, TmdbSettings
from app.schemas import DownloaderTestResult, TmdbMetadata
from app.security import encrypt_secret


@pytest.fixture
async def feed_app(monkeypatch, tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'feeds.db'}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as session:
        session.add_all([
            TmdbSettings(id=1, encrypted_api_key=encrypt_secret("test-key")),
            DownloaderConfig(
                id=1, name="qB", kind="qbittorrent", base_url="http://qb.test",
                username="admin", encrypted_secret=encrypt_secret("test-password"),
                active=True, connection_status="healthy",
            ),
        ])
        await session.commit()

    async def session_override():
        async with sessions() as session:
            yield session

    app = FastAPI()
    app.include_router(api.router)
    app.dependency_overrides[get_session] = session_override
    app.dependency_overrides[require_user] = lambda: object()
    monkeypatch.setattr(api, "SessionFactory", sessions)
    monkeypatch.setattr(api, "test_downloader", AsyncMock(return_value=DownloaderTestResult(
        ok=True, kind="qbittorrent", message="连接正常",
    )))
    monkeypatch.setattr(api, "get_library_root", AsyncMock(return_value=str(tmp_path)))
    monkeypatch.setattr(api, "scrape_tmdb", AsyncMock(return_value=TmdbMetadata(
        tmdb_id=123, media_type="tv", title="TMDB 标题", episode_count=12,
        href="https://example.test/tv/123",
    )))
    monkeypatch.setattr(api, "scrape_and_store_artwork", AsyncMock(return_value=ArtworkResult(
        directory=str(tmp_path), poster_path="poster.jpg", fanart_path="fanart.jpg",
        clearlogo_path="clearlogo.png", status="completed", error=None,
        scraped_at=datetime.now(UTC),
    )))
    yield app, sessions
    await engine.dispose()


VALUES = {
    "name": "测试订阅", "url": "https://example.test/rss",
    "tmdb": {"tmdb_id": 123, "media_type": "tv"},
}


@pytest.mark.parametrize("phase", ["scrape_tmdb", "scrape_and_store_artwork"])
async def test_response_is_sent_before_scraping_finishes(feed_app, monkeypatch, phase):
    app, sessions = feed_app
    sent = asyncio.Event()
    entered = asyncio.Event()
    release = asyncio.Event()
    response_body = bytearray()
    original = getattr(api, phase)

    async def slow_scrape(*args, **kwargs):
        entered.set()
        await release.wait()
        return await original(*args, **kwargs)

    async def observed_app(scope, receive, send):
        async def observe(message):
            if message["type"] == "http.response.body":
                response_body.extend(message.get("body", b""))
                sent.set()
            await send(message)
        await app(scope, receive, observe)

    monkeypatch.setattr(api, phase, slow_scrape)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(observed_app), base_url="http://test",
    ) as client, broker.subscribe() as events:
        task = asyncio.create_task(client.post("/api/v1/feeds", json=VALUES))
        try:
            await asyncio.wait_for(entered.wait(), 2)
            assert sent.is_set(), "刮削阻塞了保存响应"
            saved = json.loads(response_body)
            assert saved["name"] == "测试订阅"
            assert saved["show_metadata"]["tmdb_id"] == 123
            async with sessions() as session:
                source = await session.get(FeedSource, saved["id"])
                assert source.artwork.status == "pending"
            assert events.empty(), "后台任务完成前不应通知完成"
            response = await asyncio.wait_for(client.get("/api/v1/shows"), 1)
            assert response.json()[0]["artwork_status"] == "pending"
        finally:
            release.set()
            response = await asyncio.wait_for(task, 2)
        assert response.status_code == 201
        event = events.get_nowait()
        assert event.event_type == "feed.setup.completed"
        assert "刮削完成" in json.loads(event.as_sse().split("data: ")[1])["message"]
        async with sessions() as session:
            source = await session.get(FeedSource, saved["id"])
            assert source.show_metadata.episode_count == 12
            assert source.artwork.status == "completed"
        duplicate = await client.post("/api/v1/feeds", json=VALUES)
        assert duplicate.status_code == 409
        assert events.empty()


@pytest.mark.parametrize("failure, expected", [
    ("metadata", "partial"), ("artwork", "failed"), ("partial", "partial"),
])
async def test_scrape_failure_preserves_subscription_and_publishes_result(
    feed_app, monkeypatch, failure, expected,
):
    app, sessions = feed_app
    if failure == "metadata":
        monkeypatch.setattr(api, "scrape_tmdb", AsyncMock(side_effect=httpx.ReadTimeout("")))
    elif failure == "artwork":
        monkeypatch.setattr(api, "scrape_and_store_artwork", AsyncMock(
            side_effect=RuntimeError("图片保存失败"),
        ))
    else:
        api.scrape_and_store_artwork.return_value.status = "partial"
        api.scrape_and_store_artwork.return_value.error = "缺少 clearlogo"
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app), base_url="http://test",
    ) as client, broker.subscribe() as events:
        response = await client.post("/api/v1/feeds", json=VALUES)
        assert response.status_code == 201
        event = events.get_nowait()
        assert event.event_type == f"feed.setup.{expected}"
        level, _, message = event_log_fields(event.event_type, event.payload)
        assert level == ("error" if expected == "failed" else "warning")
        assert "订阅已保存" in message
        async with sessions() as session:
            source = await session.get(FeedSource, response.json()["id"])
            assert source.artwork.status == expected
            assert source.artwork.last_error
            stored = await session.scalar(select(DomainEvent))
            assert stored.event_type == event.event_type


@pytest.mark.parametrize("endpoint", ["/feeds/prerequisites", "/feeds"])
@pytest.mark.parametrize("failure, section", [
    ("no_tmdb", "tmdb"), ("no_downloader", "downloader"),
    ("inactive_downloader", "downloader"), ("offline", "downloader"),
])
async def test_prerequisites_block_creation_and_point_to_settings(
    feed_app, endpoint, failure, section,
):
    app, sessions = feed_app
    async with sessions() as session:
        if failure == "no_tmdb":
            await session.execute(delete(TmdbSettings))
        elif failure == "no_downloader":
            await session.execute(delete(DownloaderConfig))
        elif failure == "inactive_downloader":
            (await session.get(DownloaderConfig, 1)).active = False
        await session.commit()
    if failure == "offline":
        api.test_downloader.return_value = DownloaderTestResult(
            ok=False, kind="qbittorrent", message="拒绝登录",
        )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app), base_url="http://test",
    ) as client:
        response = await client.post(f"/api/v1{endpoint}", json=VALUES)
    assert response.status_code == 409
    assert response.json()["detail"]["settings_path"] == f"/settings#{section}"
    assert response.json()["detail"]["message"]
    api.scrape_tmdb.assert_not_awaited()
    async with sessions() as session:
        assert await session.scalar(select(func.count(FeedSource.id))) == 0
        if failure == "offline":
            downloader = await session.get(DownloaderConfig, 1)
            assert downloader.connection_status == "error"
            assert downloader.last_checked_at is not None
        else:
            api.test_downloader.assert_not_awaited()


@pytest.mark.parametrize("credential", ["token", "key", "both"])
async def test_either_tmdb_credential_and_live_downloader_pass(feed_app, credential):
    app, sessions = feed_app
    async with sessions() as session:
        tmdb = await session.get(TmdbSettings, 1)
        tmdb.encrypted_read_access_token = (
            encrypt_secret("test-token") if credential != "key" else None
        )
        tmdb.encrypted_api_key = encrypt_secret("test-key") if credential != "token" else None
        (await session.get(DownloaderConfig, 1)).connection_status = "error"
        await session.commit()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app), base_url="http://test",
    ) as client:
        response = await client.post("/api/v1/feeds/prerequisites")
        assert response.status_code == 200
        api.test_downloader.assert_awaited_once_with(
            "qbittorrent", "http://qb.test", "admin", "test-password", True,
        )
        # 打开弹窗检查通过后，保存时仍会复核下载器，不能依赖过期的健康状态。
        api.test_downloader.return_value = DownloaderTestResult(
            ok=False, kind="qbittorrent", message="连接中断",
        )
        response = await client.post("/api/v1/feeds", json=VALUES)
        assert response.status_code == 409
        assert response.json()["detail"]["settings_path"] == "/settings#downloader"
        assert api.test_downloader.await_count == 2


async def test_prerequisites_require_authentication(feed_app):
    app, _ = feed_app
    app.dependency_overrides.pop(require_user)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app), base_url="http://test",
    ) as client:
        response = await client.post("/api/v1/feeds/prerequisites")
        assert response.status_code == 401
    api.test_downloader.assert_not_awaited()
