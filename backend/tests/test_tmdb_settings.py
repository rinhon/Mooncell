import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import tmdb_settings
from app.database import Base, get_session
from app.dependencies import require_user
from app.models import TmdbSettings


@pytest.mark.asyncio
async def test_credentials_encrypted_preserved_cleared_and_not_returned(monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(tmdb_settings, "SessionFactory", sessions)
    async def session_override():
        async with sessions() as session:
            yield session
    app = FastAPI()
    app.include_router(tmdb_settings.router)
    app.dependency_overrides[get_session] = session_override
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                 base_url="http://test") as client:
        path = "/api/v1/settings/tmdb"
        assert (await client.get(path)).status_code == 401
        assert (await client.patch(path, json={})).status_code == 401
        app.dependency_overrides[require_user] = lambda: object()
        assert not (await client.get(path)).json()["api_key_configured"]
        result = await client.patch(path, json={"read_access_token": " token-secret ",
                                               "api_key": "key-secret"})
        assert result.status_code == 200
        assert "secret" not in result.text
        assert all(result.json().values())
        async with sessions() as session:
            saved = await session.get(TmdbSettings, 1)
            assert saved.encrypted_api_key != "key-secret"
            assert saved.encrypted_read_access_token != "token-secret"
        assert await tmdb_settings.get_credentials() == ("token-secret", "key-secret")
        await client.patch(path, json={"api_key": None})
        assert await tmdb_settings.get_credentials() == ("token-secret", "key-secret")
        await client.patch(path, json={"read_access_token": ""})
        assert await tmdb_settings.get_credentials() == (None, "key-secret")
        assert (await client.get(path)).json() == {
            "read_access_token_configured": False, "api_key_configured": True}
        assert (await client.patch(path, json={"api_key": "bad\nkey"})).status_code == 422
        await client.patch(path, json={"api_key": ""})
        assert await tmdb_settings.get_credentials() == (None, None)
    await engine.dispose()
