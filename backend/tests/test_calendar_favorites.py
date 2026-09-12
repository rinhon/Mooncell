import json

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import calendar_service as service
from app.database import Base


@pytest.mark.asyncio
async def test_favorites_persist_and_are_scoped_to_season(tmp_path, monkeypatch):
    monkeypatch.setattr(service, "cache_dir", lambda: tmp_path)
    for season in ("202601", "202604"):
        folder = tmp_path / season
        folder.mkdir()
        (folder / "season.json").write_text(json.dumps({
            "season": season, "items": [{"id": 1, "title": "测试番剧"}],
        }), encoding="utf-8")
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as session:
        for _ in range(2):
            await service.set_favorite("202601", 1, service.FavoriteUpdate(liked=True), session)
    async with sessions() as session:
        assert (await service.read_calendar("202601", session))["items"][0]["liked"]
        assert not (await service.read_calendar("202604", session))["items"][0]["liked"]
        with pytest.raises(HTTPException) as error:
            await service.set_favorite("202601", 999, service.FavoriteUpdate(liked=True), session)
        assert error.value.status_code == 404
        await service.set_favorite("202601", 1, service.FavoriteUpdate(liked=False), session)
    async with sessions() as session:
        assert not (await service.read_calendar("202601", session))["items"][0]["liked"]
    await engine.dispose()
