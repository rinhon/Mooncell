import pytest

from app.dependencies import require_user
from app.models import ShowArtwork, ShowMetadata


@pytest.mark.asyncio
async def test_detail_basic_movie_missing_and_auth(show_client):
    client, sessions, app = show_client
    response = await client.get("/api/v1/shows/1")
    assert response.status_code == 200
    data = response.json()
    assert data["genres"] == [] and data["rating"] is None
    assert data["subscription"]["name"] == "无元数据"
    assert data["poster_ready"] is False and data["artwork_status"] == "missing"
    movie = (await client.get("/api/v1/shows/2")).json()
    assert movie["media_type"] == "movie" and movie["genres"] == ["动画"]
    assert movie["episode_count"] is None
    assert (await client.get("/api/v1/shows/999")).status_code == 404
    assert (await client.get("/api/v1/shows/invalid")).status_code == 422
    app.dependency_overrides.pop(require_user)
    for path in ["/api/v1/shows/1", "/api/v1/shows/1/releases"]:
        assert (await client.get(path)).status_code == 401


@pytest.mark.asyncio
@pytest.mark.parametrize("genres", ["broken", "{}", '[1]', 'null'])
async def test_detail_tolerates_historical_genres(show_client, genres):
    client, sessions, _ = show_client
    async with sessions() as session:
        movie = await session.get(ShowMetadata, 1)
        movie.genres_json = genres
        await session.commit()
    assert (await client.get("/api/v1/shows/2")).json()["genres"] == []




@pytest.mark.asyncio
async def test_detail_uses_local_artwork_and_version_without_writes(show_client, tmp_path):
    client, sessions, _ = show_client
    poster = tmp_path / "poster.jpg"
    poster.write_bytes(b"local-file")
    async with sessions() as session:
        session.add(ShowArtwork(source_id=1, directory=str(tmp_path), status="partial",
                                poster_path=str(poster), fanart_path=str(tmp_path / "missing.jpg")))
        await session.commit()
    data = (await client.get("/api/v1/shows/1")).json()
    assert data["poster_ready"] is True
    assert data["fanart_ready"] is False and data["clearlogo_ready"] is False
    async with sessions() as session:
        artwork = await session.get(ShowArtwork, 1)
        assert artwork.status == "partial" and artwork.scraped_at is None
    assert data["artwork_version"] is None
