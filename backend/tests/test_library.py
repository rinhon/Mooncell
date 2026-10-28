from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.database import Base, get_session
from app.dependencies import require_user
from app.library import get_library_root, router


@pytest.mark.asyncio
async def test_directory_selection_persists_and_rejects_files(tmp_path: Path):
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
    folder = tmp_path / "中文媒体库"
    folder.mkdir()
    (folder / "Season 01").mkdir()
    media = folder / "episode.mkv"
    media.write_text("test")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        listing = await client.get("/api/v1/filesystem/directories", params={"path": str(folder)})
        assert listing.status_code == 200
        assert [item["name"] for item in listing.json()["children"]] == ["Season 01"]
        response = await client.patch(
            "/api/v1/settings/library",
            json={"library_root": str(folder)},
        )
        assert response.status_code == 200
        saved = (await client.get("/api/v1/settings/library")).json()
        assert saved["library_root"] == str(folder.resolve())
        async with sessions() as session:
            assert await get_library_root(session, "old-path") == str(folder.resolve())
        for invalid in [str(media), str(folder / "missing"), "relative-path"]:
            response = await client.patch(
                "/api/v1/settings/library",
                json={"library_root": invalid},
            )
            assert response.status_code in {404, 422}
            assert (await client.get("/api/v1/settings/library")).json() == saved
        empty = await client.get(
            "/api/v1/filesystem/directories",
            params={"path": str(folder / "Season 01")},
        )
        assert empty.json()["children"] == []
    await engine.dispose()
