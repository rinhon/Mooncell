import httpx
import pytest

from app.providers import tmdb


def test_detail_tv_and_movie_fields():
    tv = tmdb.parse_tmdb_detail({"name": "死神", "number_of_episodes": 416,
        "first_air_date": "2004-10-05", "genres": [{"id": 16, "name": "动画"}],
        "vote_average": 8.4, "poster_path": "/poster.jpg"}, 30984, "tv")
    assert tv.episode_count == 416
    assert tv.genres == ["动画"]
    assert tv.poster_url == "https://image.tmdb.org/t/p/original/poster.jpg"
    assert tv.release_date == "2004-10-05"
    movie = tmdb.parse_tmdb_detail({"title": "电影", "release_date": "2026-01-01",
                                  "number_of_episodes": 99}, 1, "movie")
    assert movie.title == "电影"
    assert movie.episode_count is None
    assert movie.poster_url is None


@pytest.mark.asyncio
@pytest.mark.parametrize("token,key", [("read-token", "key-secret"), (None, "key-secret")])
async def test_api_auth_search_details_images(monkeypatch, token, key):
    async def credentials():
        return token, key
    monkeypatch.setattr(tmdb, "get_credentials", credentials)
    requests = []
    def handler(request):
        requests.append(request)
        if token:
            assert request.headers["Authorization"] == "Bearer read-token"
            assert "api_key" not in request.url.params
        else:
            assert "Authorization" not in request.headers
            assert request.url.params["api_key"] == key
        if request.url.path.endswith("/search/multi"):
            return httpx.Response(200, json={"results": [
                {"id": 1, "media_type": "person", "name": "演员"},
                {"id": 2, "media_type": "tv", "name": "番剧", "poster_path": "/p.jpg"}]})
        if request.url.path.endswith("/images"):
            assert "language" not in request.url.params
            return httpx.Response(200, json={"logos": [
                {"file_path": "/en.png", "iso_639_1": "en", "vote_average": 9},
                {"file_path": "/zh.png", "iso_639_1": "zh", "vote_average": 1}],
                "backdrops": [{"file_path": "/bg.jpg", "iso_639_1": None}]})
        return httpx.Response(200, json={"name": "番剧", "number_of_episodes": 12})
    original = httpx.AsyncClient
    monkeypatch.setattr(tmdb.httpx, "AsyncClient", lambda **kw:
                        original(transport=httpx.MockTransport(handler), **kw))
    assert [item.tmdb_id for item in await tmdb.search_tmdb("番剧")] == [2]
    assert (await tmdb.scrape_tmdb(2, "tv")).episode_count == 12
    images = await tmdb.scrape_tmdb_artwork_urls(2, "tv", "https://example.com/poster.jpg")
    assert images.clearlogo.endswith("/zh.png")
    assert images.fanart.endswith("/bg.jpg")
    assert images.poster == "https://example.com/poster.jpg"
    assert len(requests) == 3


@pytest.mark.asyncio
async def test_missing_credentials_and_sanitized_errors(monkeypatch):
    async def missing():
        return None, None
    monkeypatch.setattr(tmdb, "get_credentials", missing)
    with pytest.raises(ValueError, match="请先在设置中配置"):
        await tmdb.scrape_tmdb(1, "tv")
    async def credentials():
        return None, "private-key"
    monkeypatch.setattr(tmdb, "get_credentials", credentials)
    original = httpx.AsyncClient
    monkeypatch.setattr(tmdb.httpx, "AsyncClient", lambda **kw: original(
        transport=httpx.MockTransport(lambda request: httpx.Response(401)), **kw))
    with pytest.raises(ValueError, match="认证失败") as error:
        await tmdb.scrape_tmdb(1, "tv")
    assert "private-key" not in str(error.value)
