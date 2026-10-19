import httpx
import pytest_asyncio
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api import router
from app.database import Base, get_session
from app.dependencies import require_user
from app.models import FeedSource, ShowMetadata


@pytest_asyncio.fixture
async def show_client():
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
        source = FeedSource(name="无元数据", url="https://example.com/1")
        movie = FeedSource(name="电影", url="https://example.com/2")
        session.add_all([source, movie])
        await session.flush()
        movie.show_metadata = ShowMetadata(tmdb_id=12, media_type="movie", title="电影",
                                          genres_json='["动画"]', href="https://tmdb.org/movie/12")
        await session.commit()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test",
    ) as client:
        yield client, sessions, app
    await engine.dispose()
