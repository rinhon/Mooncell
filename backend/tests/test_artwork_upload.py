import subprocess

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api import router
from app.artwork_service import store_uploaded_artwork
from app.config import settings
from app.database import Base, get_session
from app.dependencies import require_user
from app.models import DomainEvent, FeedSource


@pytest.fixture
def png():
    return subprocess.run(
        ["magick", "-size", "12x16", "xc:none", "png:-"],
        check=True,
        capture_output=True,
    ).stdout


def test_preserve_transparency_and_invalid_upload_preserves_existing(tmp_path, png):
    path = store_uploaded_artwork(png, tmp_path, "clearlogo")
    opacity = subprocess.run(
        ["magick", str(path), "-format", "%[opaque]", "info:"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    assert opacity == "False"
    original = path.read_bytes()
    with pytest.raises(ValueError):
        store_uploaded_artwork(b"not an image", tmp_path, "clearlogo")
    assert path.read_bytes() == original
    with pytest.raises(ValueError):
        store_uploaded_artwork(png[:16], tmp_path, "clearlogo")
    assert path.read_bytes() == original


async def test_upload_routes_and_persistence(monkeypatch, tmp_path, png):
    monkeypatch.setattr(settings, "media_library_root", str(tmp_path))
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
    async with sessions() as session:
        source = FeedSource(name="上传测试", url="https://example.test/rss")
        session.add(source)
        await session.commit()
        source_id = source.id
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://test",
        ) as client:
            base = f"/api/v1/shows/{source_id}/artwork"
            assert (await client.post(f"{base}/poster", content=png)).status_code == 401
            assert (await client.get(f"{base}/clearlogo/appearance")).status_code == 401
            app.dependency_overrides[require_user] = lambda: object()
            assert (await client.get(f"{base}/clearlogo/appearance")).status_code == 404
            previous_versions = {}
            for kind in ("poster", "fanart", "clearlogo"):
                response = await client.post(f"{base}/{kind}", content=png)
                assert response.status_code == 200, response.text
                assert response.json()[f"{kind}_ready"]
                assert response.json()["artwork_version"]
                versions = response.json()["artwork_versions"]
                assert all(versions[key] == value for key, value in previous_versions.items())
                previous_versions = versions
                image = await client.get(f"{base}/{kind}", params={"v": versions[kind]})
                assert image.status_code == 200
                assert image.headers["content-type"].startswith("image/")
                assert image.headers["cache-control"] == "private, max-age=31536000"
            assert response.json()["artwork_status"] == "completed"
            appearance = await client.get(f"{base}/clearlogo/appearance")
            assert appearance.status_code == 200
            assert appearance.json() == {"background": "dark"}
            assert (await client.post(f"{base}/invalid", content=png)).status_code == 422
            assert (await client.post(f"{base}/poster", content=b"bad")).status_code == 422
            assert (
                await client.post(
                    f"{base}/poster",
                    content=b"x" * (10 * 1024 * 1024 + 1),
                )
            ).status_code == 413
            async with sessions() as session:
                events = list(await session.scalars(select(DomainEvent)))
                assert sum(e.event_type == "artwork.upload.completed" for e in events) == 3
                assert sum(e.event_type == "artwork.upload.failed" for e in events) == 2
    finally:
        await engine.dispose()
