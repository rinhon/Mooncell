import asyncio
import threading
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import rss_service, subscription_settings
from app.api import router
from app.database import Base, get_session
from app.dependencies import require_user
from app.models import FeedSource


async def test_startup_grace_period_is_cancellable(monkeypatch):
    sleeping = asyncio.Event()
    delays = []

    async def sleep(delay):
        delays.append(delay)
        sleeping.set()
        await asyncio.Event().wait()

    refresh = AsyncMock()
    monkeypatch.setattr(subscription_settings.asyncio, "sleep", sleep)
    monkeypatch.setattr(subscription_settings, "refresh_due_feeds", refresh)
    task = asyncio.create_task(subscription_settings.subscription_refresh_loop())
    await sleeping.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert delays == [30]
    refresh.assert_not_awaited()


@pytest.mark.parametrize("phase", ["network", "parser"])
async def test_homepage_responds_during_refresh(monkeypatch, tmp_path, phase):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'test.db'}")
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
    entered = asyncio.Event()
    release = threading.Event()
    loop = asyncio.get_running_loop()
    parse = rss_service.feedparser.parse
    original_client = httpx.AsyncClient

    async with sessions() as session:
        source = FeedSource(name="test", url="https://example.com/rss")
        session.add(source)
        await session.commit()

        async def transport(request):
            assert not session.in_transaction()
            if phase == "network":
                entered.set()
                await asyncio.to_thread(release.wait, 5)
                raise httpx.ReadTimeout("")
            return httpx.Response(
                200,
                content=b"<rss><channel><title>Test</title>"
                b"<item><title>Example 01</title><guid>1</guid></item>"
                b"<item><title>Example 01</title><guid>1</guid></item>"
                b"</channel></rss>",
            )

        def slow_parse(content):
            assert not session.in_transaction()
            loop.call_soon_threadsafe(entered.set)
            assert release.wait(5), "RSS parsing blocked the event loop"
            return parse(content)

        monkeypatch.setattr(
            rss_service.httpx,
            "AsyncClient",
            lambda **kwargs: original_client(transport=httpx.MockTransport(transport)),
        )
        monkeypatch.setattr(rss_service.feedparser, "parse", slow_parse)
        task = asyncio.create_task(rss_service.FeedRefreshService(session).refresh(source))
        try:
            await asyncio.wait_for(entered.wait(), 2)
            async with original_client(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                response = await asyncio.wait_for(client.get("/api/v1/shows"), 1)
                assert response.status_code == 200
                assert not task.done()
        finally:
            release.set()
            result = (await asyncio.gather(task, return_exceptions=True))[0]
        if phase == "network":
            assert isinstance(result, httpx.ReadTimeout)
            assert source.connection_status == "error"
            assert "ReadTimeout" in source.last_error
            assert source.last_checked_at is not None
        else:
            assert not isinstance(result, BaseException), result
            assert result.created == 1
            assert result.duplicates == 1
    await engine.dispose()
