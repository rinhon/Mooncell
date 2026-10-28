from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.database import Base, get_session
from app.dependencies import require_user
from app.models import FeedSource
from app.subscription_settings import is_due, router


def test_refresh_due_handles_sqlite_naive_timestamps():
    now = datetime.now(UTC)
    source = FeedSource(name="test", url="https://example.com/rss")
    assert is_due(source, 5, now)
    source.last_checked_at = (now - timedelta(minutes=4)).replace(tzinfo=None)
    assert not is_due(source, 5, now)
    source.last_checked_at = now - timedelta(minutes=5)
    assert is_due(source, 5, now)


@pytest.mark.asyncio
async def test_settings_persist_validate_and_route_only_rss(monkeypatch):
    from app import rss_service

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)

    async def session_override():
        async with sessions() as session:
            yield session

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_session] = session_override
    app.dependency_overrides[require_user] = lambda: object()
    async with sessions() as session:
        source = FeedSource(name="test", url="https://example.com/rss")
        session.add(source)
        await session.commit()
        source_id = source.id
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        path = "/api/v1/settings/subscriptions"
        assert (await client.get(path)).json()["refresh_interval_minutes"] == 5
        for invalid in (0, 1441):
            assert (
                await client.patch(path, json={"refresh_interval_minutes": invalid})
            ).status_code == 422
        assert (await client.patch(path, json={"proxy_url": "ftp://proxy.test"})).status_code == 422
        data = {"proxy_url": "http://127.0.0.1:7890/", "refresh_interval_minutes": 30}
        assert (await client.patch(path, json=data)).json() == data
        assert (await client.get(path)).json() == data
        async with sessions() as session:
            assert (await session.get(FeedSource, source_id)).refresh_interval_minutes == 30

        original_client = httpx.AsyncClient
        captured = []

        def rss_client(**kwargs):
            captured.append(kwargs)
            return original_client(
                transport=httpx.MockTransport(
                    lambda request: httpx.Response(
                        200,
                        content=b"<rss><channel><title>Example</title></channel></rss>",
                    )
                )
            )

        monkeypatch.setattr(rss_service, "SessionFactory", sessions)
        monkeypatch.setattr(rss_service.httpx, "AsyncClient", rss_client)
        await rss_service.inspect_feed("https://example.com/rss")
        async with sessions() as session:
            await rss_service.FeedRefreshService(session).refresh(
                await session.get(FeedSource, source_id)
            )
        assert len(captured) == 2
        assert all(
            call["proxy"] == data["proxy_url"] and call["trust_env"] is False for call in captured
        )
        assert (
            await client.patch(path, json={"proxy_url": None, "refresh_interval_minutes": 5})
        ).status_code == 200
        await rss_service.inspect_feed("https://example.com/rss")
        assert captured[-1]["proxy"] is None
    await engine.dispose()
