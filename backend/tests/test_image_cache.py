import os
from datetime import UTC, datetime

import pytest_asyncio

from app.config import settings
from app.dependencies import require_user
from app.library_scan import ImageFile
from app.models import EpisodeThumbnail, ShowArtwork, User
from app.security import create_user_session


@pytest_asyncio.fixture(params=["artwork", "thumbnail"])
async def image_client(show_client, tmp_path, request):
    client, sessions, app = show_client
    path = tmp_path / "episode-thumb.jpg"
    path.write_bytes(b"original-image")
    stat = path.stat()
    version_path = str(path) if request.param == "artwork" else path.name
    version = ImageFile(version_path, stat.st_mtime_ns, stat.st_size).version
    async with sessions() as session:
        session.add(ShowArtwork(source_id=1, directory=str(tmp_path), poster_path=str(path)))
        thumbnail = EpisodeThumbnail(
            source_id=1,
            video_path="episode.mkv",
            image_path=path.name,
            file_version=version,
        )
        session.add(thumbnail)
        user = User(username="image-test", password_hash="unused")
        session.add(user)
        await session.flush()
        token = await create_user_session(session, user.id)
        await session.commit()
        url = (
            "/api/v1/shows/1/artwork/poster"
            if request.param == "artwork"
            else f"/api/v1/shows/1/thumbnails/{thumbnail.id}"
        )
    app.dependency_overrides.pop(require_user)
    client.cookies.set(settings.session_cookie_name, token)
    yield client, url, path, version, version_path


async def test_image_conditional_get_and_head(image_client):
    client, url, path, version, _ = image_client
    initial = await client.get(url)
    assert initial.status_code == 200
    assert initial.content == path.read_bytes()
    assert initial.headers["cache-control"] == "private, no-cache"
    assert initial.headers["etag"] == f'W/"{version}"'
    date = initial.headers["last-modified"]
    etag = initial.headers["etag"]

    head = await client.head(url)
    assert head.status_code == 200 and head.content == b""
    for name in ("etag", "last-modified", "cache-control", "content-length"):
        assert head.headers[name] == initial.headers[name]

    for method in (client.get, client.head):
        for headers in (
            {"If-None-Match": etag},
            {"If-None-Match": f'"another", {etag.removeprefix("W/")}'},
            {"If-None-Match": "*"},
            {"If-Modified-Since": date},
        ):
            cached = await method(url, headers=headers)
            assert cached.status_code == 304
            assert cached.content == b""
            for name in ("etag", "last-modified", "cache-control"):
                assert cached.headers[name] == initial.headers[name]

    # 匹配日期不能覆盖不匹配的 ETag，非法日期也不应误命中缓存。
    for headers in (
        {"If-None-Match": '"stale"', "If-Modified-Since": date},
        {"If-None-Match": "", "If-Modified-Since": date},
        {"If-Modified-Since": "invalid-date"},
        {"If-Modified-Since": "Mon, 01 Jan 1990 00:00:00 GMT"},
    ):
        assert (await client.get(url, headers=headers)).status_code == 200


async def test_image_cache_policy_matches_current_file_not_database_version(image_client):
    client, url, path, version, version_path = image_client
    original = await client.get(url, params={"v": version})
    assert original.status_code == 200
    assert original.headers["cache-control"] == "private, max-age=31536000"
    assert "immutable" not in original.headers["cache-control"]
    cached = await client.get(
        url,
        params={"v": version},
        headers={"If-None-Match": original.headers["etag"]},
    )
    assert cached.status_code == 304
    assert cached.headers["cache-control"] == original.headers["cache-control"]

    previous_stat = path.stat()
    path.write_bytes(b"replacement-image-with-new-size")
    os.utime(path, ns=(previous_stat.st_atime_ns, previous_stat.st_mtime_ns + 2_000_000_000))
    current_stat = path.stat()
    current_version = ImageFile(
        version_path,
        current_stat.st_mtime_ns,
        current_stat.st_size,
    ).version
    assert current_version != version

    # 数据库仍持有旧缩略图版本时，也只能按实际文件判断是否允许长期缓存。
    for params in ({"v": version}, {"v": "unknown"}, {}):
        changed = await client.get(
            url,
            params=params,
            headers={"If-None-Match": original.headers["etag"]},
        )
        assert changed.status_code == 200
        assert changed.content == path.read_bytes()
        assert changed.headers["etag"] == f'W/"{current_version}"'
        assert changed.headers["cache-control"] == "private, no-cache"
    current = await client.get(url, params={"v": current_version})
    assert current.headers["cache-control"] == "private, max-age=31536000"
    if url.endswith("/artwork/poster"):
        detail = (await client.get("/api/v1/shows/1")).json()
        assert detail["artwork_versions"]["poster"] == current_version


async def test_image_conditional_requests_still_require_authentication(image_client):
    client, url, path, version, _ = image_client
    client.cookies.clear()
    for method in (client.get, client.head):
        response = await method(
            url,
            params={"v": version},
            headers={"If-None-Match": f'W/"{version}"'},
        )
        assert response.status_code == 401
        assert "etag" not in response.headers
    path.unlink()
    # 匿名条件请求不能借 404/304 探测文件存在性。
    assert (await client.get(url, headers={"If-None-Match": "*"})).status_code == 401


async def test_artwork_versions_are_independent_of_global_scan_state(show_client, tmp_path):
    client, sessions, _ = show_client
    poster = tmp_path / "poster.jpg"
    logo = tmp_path / "clearlogo.png"
    poster.write_bytes(b"poster")
    logo.write_bytes(b"logo")
    async with sessions() as session:
        session.add(
            ShowArtwork(
                source_id=1,
                directory=str(tmp_path),
                poster_path=str(poster),
                clearlogo_path=str(logo),
                fanart_path=str(tmp_path / "missing.jpg"),
                file_version="scan-before",
                scraped_at=datetime(2020, 1, 1, tzinfo=UTC),
            )
        )
        await session.commit()
    before = (await client.get("/api/v1/shows/1")).json()
    assert set(before["artwork_versions"]) == {"poster", "clearlogo"}
    assert before["poster_ready"] and before["clearlogo_ready"] and not before["fanart_ready"]
    async with sessions() as session:
        artwork = await session.get(ShowArtwork, 1)
        artwork.file_version = "scan-after"
        artwork.scraped_at = datetime(2021, 1, 1, tzinfo=UTC)
        await session.commit()
    after = (await client.get("/api/v1/shows/1")).json()
    assert after["artwork_version"] != before["artwork_version"]
    assert after["artwork_versions"] == before["artwork_versions"]
    for kind, version in after["artwork_versions"].items():
        response = await client.get(f"/api/v1/shows/1/artwork/{kind}", params={"v": version})
        assert response.headers["cache-control"] == "private, max-age=31536000"
