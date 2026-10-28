import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api import router
from app.database import Base, get_session
from app.dependencies import require_user
from app.models import FeedItem, FeedSource


@pytest.mark.asyncio
async def test_show_items_returns_only_titles_in_newest_first_order():
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
        source = FeedSource(name="测试番剧", url="https://example.com/rss")
        session.add(source)
        await session.flush()
        session.add_all(
            [
                FeedItem(
                    source_id=source.id, title="较早标题", fingerprint="older", parse_data="{}"
                ),
                FeedItem(
                    source_id=source.id, title="较新标题", fingerprint="newer", parse_data="{}"
                ),
            ]
        )
        await session.commit()
        source_id = source.id

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        response = await client.get(f"/api/v1/shows/{source_id}/items")
        assert response.status_code == 200
        assert response.json() == ["较新标题", "较早标题"]
        assert (await client.get("/api/v1/shows/999/items")).status_code == 404

    await engine.dispose()
