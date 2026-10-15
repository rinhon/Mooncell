from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import BackgroundTasks
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import api, database, rss_service
from app.api import create_feed
from app.database import Base
from app.models import FeedItem
from app.schemas import FeedCreate, FeedRead


def test_keyword_defaults_and_normalization():
    assert FeedCreate(url="https://example.com/rss").excluded_keywords == ["720"]
    assert FeedCreate(url="https://example.com/rss", excluded_keywords=[]).excluded_keywords == []
    assert FeedCreate(url="https://example.com/rss", excluded_keywords=[" RAW ", "raw", ""]).excluded_keywords == ["RAW"]
    with pytest.raises(ValueError):
        FeedCreate(url="https://example.com/rss", excluded_keywords=["x" * 101])


@pytest.mark.parametrize("keywords, expected", [(["720"], 2), (["720", "raw"], 1), ([], 3)])
async def test_create_persist_and_filter(monkeypatch, keywords, expected):
    monkeypatch.setattr(api, "_validate_feed_prerequisites", AsyncMock())
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    original_client = httpx.AsyncClient
    titles = ["Example 01 720p", "Example 01 1080p RAW", "Example 01 1080p"]
    xml = "<rss><channel>" + "".join(
        f"<item><title>{title}</title><guid>{index}</guid></item>"
        for index, title in enumerate(titles)
    ) + "</channel></rss>"
    transport = httpx.MockTransport(lambda request: httpx.Response(200, text=xml))
    monkeypatch.setattr(rss_service.httpx, "AsyncClient", lambda **kwargs: original_client(transport=transport))
    monkeypatch.setattr(rss_service.FeedRefreshService, "_enqueue_downloads", AsyncMock())
    async with sessions() as session:
        source = await create_feed(FeedCreate(name="Example", url="https://example.com/rss", excluded_keywords=keywords), BackgroundTasks(), _user=object(), session=session)
        await session.refresh(source)
        assert FeedRead.model_validate(source).excluded_keywords == keywords
        result = await rss_service.FeedRefreshService(session).refresh(source)
        assert result.created == expected
        saved = list(await session.scalars(select(FeedItem)))
        assert len(saved) == expected
        assert all(not any(word.casefold() in item.title.casefold() for word in keywords) for item in saved)
        repeat = await rss_service.FeedRefreshService(session).refresh(source)
        assert repeat.created == 0
        assert repeat.duplicates == expected
    await engine.dispose()


async def test_existing_database_migration(monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.execute(text("CREATE TABLE feed_sources (id INTEGER PRIMARY KEY, season INTEGER)"))
        await connection.execute(text("INSERT INTO feed_sources (id) VALUES (1)"))
    monkeypatch.setattr(database, "engine", engine)
    await database.init_database()
    await database.init_database()
    async with engine.connect() as connection:
        assert await connection.scalar(text("SELECT excluded_keywords FROM feed_sources WHERE id=1")) == "[]"
    await engine.dispose()
