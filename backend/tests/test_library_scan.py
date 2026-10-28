import os

import pytest
from sqlalchemy import func, select

from app.library_scan import local_image, scan_images, scan_media_library, scan_source
from app.models import DomainEvent, EpisodeThumbnail, FeedSource, ShowArtwork, ShowMetadata


def put(root, name, content=b"image"):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return path


async def bind(sessions, root):
    async with sessions() as session:
        source = await session.get(FeedSource, 2)
        source.artwork = ShowArtwork(directory=str(root), status="partial")
        await session.commit()


def test_names_real_video_matching_and_ignored_files(tmp_path):
    for name in [
        "POSTER.PNG",
        "backdrop.webp",
        "logo.png",
        "Season 01/作品 S01E01.MKV",
        "Season 01/作品 S01E01-thumb.JPG",
        "Season 01/作品 S01E01.jpg",
        "Season 01/作品 S01E02.mp4",
        "Season 01/作品 S01E02.webp",
        "Season 01/孤立-thumb.jpg",
        "Season 01/poster.jpg",
        ".hidden/作品 S01E03.mkv",
        ".hidden/作品 S01E03-thumb.jpg",
        "Season 01/作品 S01E04.mkv.!qB",
        "Season 01/作品 S01E04-thumb.jpg",
        "Season 01/作品 S01E02-320.bif",
    ]:
        put(tmp_path, name)
    data = scan_images(tmp_path)
    assert not data.partial
    assert data.artwork["poster"].path == "POSTER.PNG"
    assert data.artwork["fanart"].path == "backdrop.webp"
    assert data.artwork["clearlogo"].path == "logo.png"
    assert {video: image.path for video, image in data.thumbnails.items()} == {
        "Season 01/作品 S01E01.MKV": "Season 01/作品 S01E01-thumb.JPG",
        "Season 01/作品 S01E02.mp4": "Season 01/作品 S01E02.webp",
    }


@pytest.mark.asyncio
async def test_scan_syncs_without_changing_confirmed_metadata_and_is_idempotent(
    show_client,
    monkeypatch,
    tmp_path,
):
    client, sessions, _ = show_client
    monkeypatch.setattr("app.library_scan.SessionFactory", sessions)
    await bind(sessions, tmp_path)
    for name in ["poster.jpg", "fanart.jpg", "clearlogo.png", "电影.mkv", "电影-thumb.jpg"]:
        put(tmp_path, name)
    put(tmp_path, "tvshow.nfo", b"<tvshow><tmdbid>999</tmdbid></tvshow>")
    assert await scan_source(2) == (True, 1)
    async with sessions() as session:
        artwork = await session.scalar(select(ShowArtwork))
        assert artwork.status == "completed" and artwork.last_error is None
        assert artwork.scraped_at is None
        version = artwork.file_version
        assert (await session.get(ShowMetadata, 1)).tmdb_id == 12
        thumbnail = await session.scalar(select(EpisodeThumbnail))
        thumb_id = thumbnail.id
    assert await scan_source(2) == (False, 1)
    async with sessions() as session:
        assert await session.scalar(select(func.count(DomainEvent.id))) == 1
    detail = (await client.get("/api/v1/shows/2")).json()
    assert detail["artwork_version"] == version
    library = (await client.get("/api/v1/shows/2/library")).json()
    url = library["seasons"][0]["items"][0]["thumbnail_url"]
    assert (await client.get(url)).content == b"image"
    assert (await client.get(f"/api/v1/shows/1/thumbnails/{thumb_id}")).status_code == 404


@pytest.mark.asyncio
async def test_overwrite_missing_and_reappearance_update_versions(
    show_client,
    monkeypatch,
    tmp_path,
):
    _, sessions, _ = show_client
    monkeypatch.setattr("app.library_scan.SessionFactory", sessions)
    await bind(sessions, tmp_path)
    poster = put(tmp_path, "poster.jpg")
    logo = put(tmp_path, "clearlogo.png")
    put(tmp_path, "作品.mkv")
    thumb = put(tmp_path, "作品-thumb.jpg")
    await scan_source(2)
    async with sessions() as session:
        version = (await session.scalar(select(ShowArtwork))).file_version
        thumb_version = (await session.scalar(select(EpisodeThumbnail))).file_version
    for path in (poster, thumb):
        stat = path.stat()
        os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))
    assert await scan_source(2) == (True, 1)
    async with sessions() as session:
        assert (await session.scalar(select(ShowArtwork))).file_version != version
        assert (await session.scalar(select(EpisodeThumbnail))).file_version != thumb_version
    logo.unlink()
    thumb.unlink()
    assert await scan_source(2) == (True, 0)
    async with sessions() as session:
        artwork = await session.scalar(select(ShowArtwork))
        assert artwork.status == "partial" and artwork.clearlogo_path == str(logo)
        assert await session.scalar(select(func.count(EpisodeThumbnail.id))) == 0
    logo.write_bytes(b"restored")
    assert await scan_source(2) == (True, 0)


@pytest.mark.asyncio
async def test_renamed_video_thumbnail_overwrite_updates_url_and_scan_is_idempotent(
    show_client,
    monkeypatch,
    tmp_path,
):
    client, sessions, _ = show_client
    monkeypatch.setattr("app.library_scan.SessionFactory", sessions)
    await bind(sessions, tmp_path)
    old_video = "Season 01/作品 S01E01.mkv"
    new_video = "Season 01/作品 S01E01 修正版.mkv"
    image_path = "Season 01/作品 S01E01-thumb.jpg"
    video = put(tmp_path, old_video, b"video")
    image = put(tmp_path, image_path)
    assert await scan_source(2) == (True, 1)
    before = (await client.get("/api/v1/shows/2/library")).json()
    old_url = before["seasons"][0]["items"][0]["thumbnail_url"]
    assert old_url and (await client.get(old_url)).content == b"image"
    async with sessions() as session:
        thumbnail = await session.scalar(select(EpisodeThumbnail))
        thumbnail_id, old_version = thumbnail.id, thumbnail.file_version
        # 模拟改名流程：只移动视频并更新视频关联，缩略图沿用原文件名。
        video.rename(tmp_path / new_video)
        thumbnail.video_path = new_video
        await session.commit()
    assert await scan_source(2) == (False, 0)
    renamed = (await client.get("/api/v1/shows/2/library")).json()
    episode = renamed["seasons"][0]["items"][0]
    assert episode["path"] == new_video and episode["thumbnail_url"] == old_url
    image.write_bytes(b"updated image")
    assert await scan_source(2) == (True, 0)
    async with sessions() as session:
        thumbnail = await session.scalar(select(EpisodeThumbnail))
        assert thumbnail.id == thumbnail_id and thumbnail.image_path == image_path
        assert thumbnail.video_path == new_video and thumbnail.file_version != old_version
        assert await session.scalar(select(func.count(DomainEvent.id))) == 2
    updated = (await client.get("/api/v1/shows/2/library")).json()
    new_url = updated["seasons"][0]["items"][0]["thumbnail_url"]
    assert new_url and new_url != old_url
    assert (await client.get(new_url)).content == b"updated image"
    assert await scan_source(2) == (False, 0)
    async with sessions() as session:
        assert await session.scalar(select(func.count(DomainEvent.id))) == 2


@pytest.mark.asyncio
async def test_unavailable_directory_preserves_records_and_other_shows_continue(
    show_client,
    monkeypatch,
    tmp_path,
):
    _, sessions, _ = show_client
    monkeypatch.setattr("app.library_scan.SessionFactory", sessions)
    await bind(sessions, tmp_path)
    put(tmp_path, "电影.mkv")
    put(tmp_path, "电影-thumb.jpg")
    await scan_source(2)
    async with sessions() as session:
        artwork = await session.scalar(select(ShowArtwork))
        artwork.directory = str(tmp_path / "unmounted")
        version = artwork.file_version
        other = tmp_path / "other"
        put(other, "poster.png")
        session.add(ShowArtwork(source_id=1, directory=str(other), status="partial"))
        await session.commit()
    await scan_media_library()
    async with sessions() as session:
        assert (
            await session.scalar(
                select(ShowArtwork).where(ShowArtwork.source_id == 2),
            )
        ).file_version == version
        assert (
            await session.scalar(
                select(ShowArtwork).where(ShowArtwork.source_id == 1),
            )
        ).poster_path == str(other / "poster.png")
        assert await session.scalar(select(func.count(EpisodeThumbnail.id))) == 1


@pytest.mark.asyncio
async def test_thumbnail_endpoint_rejects_traversal_and_requires_auth(show_client, tmp_path):
    client, sessions, app = show_client
    await bind(sessions, tmp_path)
    async with sessions() as session:
        image = EpisodeThumbnail(
            source_id=2, video_path="a.mkv", image_path="../outside.jpg", file_version="test"
        )
        session.add(image)
        await session.commit()
        image_id = image.id
    assert (await client.get(f"/api/v1/shows/2/thumbnails/{image_id}")).status_code == 404
    from app.dependencies import require_user

    app.dependency_overrides.pop(require_user)
    assert (await client.get(f"/api/v1/shows/2/thumbnails/{image_id}")).status_code == 401


def test_local_image_and_scanner_do_not_follow_links(tmp_path):
    root = tmp_path / "show"
    root.mkdir()
    outside = put(tmp_path, "outside.jpg")
    with pytest.raises(ValueError):
        local_image(root, "../outside.jpg")
    try:
        (root / "poster.jpg").symlink_to(outside)
    except OSError:
        pytest.skip("当前系统未允许创建符号链接")
    assert scan_images(root).artwork["poster"] is None
    with pytest.raises(ValueError):
        local_image(root, "poster.jpg")


@pytest.mark.asyncio
async def test_partial_scan_preserves_unread_thumbnails(show_client, monkeypatch, tmp_path):
    _, sessions, _ = show_client
    monkeypatch.setattr("app.library_scan.SessionFactory", sessions)
    await bind(sessions, tmp_path)
    put(tmp_path, "a.mkv")
    put(tmp_path, "a-thumb.jpg")
    await scan_source(2)
    result = scan_images(tmp_path)
    result.partial = True
    result.thumbnails = {}
    monkeypatch.setattr("app.library_scan.scan_images", lambda _: result)
    await scan_source(2)
    async with sessions() as session:
        assert await session.scalar(select(func.count(EpisodeThumbnail.id))) == 1


@pytest.mark.asyncio
async def test_concurrent_rename_discards_scan(show_client, monkeypatch, tmp_path):
    _, sessions, _ = show_client
    monkeypatch.setattr("app.library_scan.SessionFactory", sessions)
    await bind(sessions, tmp_path)
    put(tmp_path, "poster.jpg")

    async def scan_then_rename(function, *args):
        result = function(*args)
        async with sessions() as session:
            source = await session.get(FeedSource, 2)
            source.name = "新名称"
            await session.commit()
        return result

    monkeypatch.setattr("app.library_scan.asyncio.to_thread", scan_then_rename)
    assert await scan_source(2) == (False, 0)
    async with sessions() as session:
        artwork = await session.scalar(select(ShowArtwork))
        assert artwork.poster_path is None and artwork.file_version is None


@pytest.mark.asyncio
async def test_active_scrape_skipped_but_interrupted_scrape_can_scan(
    show_client,
    monkeypatch,
    tmp_path,
):
    from app.models import BackgroundOperation, User

    _, sessions, _ = show_client
    monkeypatch.setattr("app.library_scan.SessionFactory", sessions)
    await bind(sessions, tmp_path)
    put(tmp_path, "poster.jpg")
    async with sessions() as session:
        session.add(User(id=1, username="test", password_hash="test"))
        source = await session.get(FeedSource, 2)
        source.artwork.status = "pending"
        operation = BackgroundOperation(
            user_id=1, source_id=2, source_name="电影", kind="artwork_scrape", status="running"
        )
        session.add(operation)
        await session.commit()
        operation_id = operation.id
    assert await scan_source(2) == (False, 0)
    async with sessions() as session:
        operation = await session.get(BackgroundOperation, operation_id)
        operation.status = "failed"
        await session.commit()
    assert await scan_source(2) == (True, 0)


@pytest.mark.asyncio
async def test_manual_scan_status_and_auth(show_client, monkeypatch, tmp_path):
    from app.dependencies import require_user
    from app.library_scan import router

    client, sessions, app = show_client
    app.include_router(router)
    monkeypatch.setattr("app.library_scan.settings.library_scan_interval_seconds", 0)
    monkeypatch.setattr("app.library_scan.SessionFactory", sessions)
    await bind(sessions, tmp_path)
    put(tmp_path, "poster.jpg")
    assert (await client.post("/api/v1/settings/library-scan")).status_code == 202
    status = (await client.get("/api/v1/settings/library-scan")).json()
    assert not status["running"] and status["finished_at"]
    assert status["changed"] == 1 and status["interval_seconds"] == 0
    app.dependency_overrides.pop(require_user)
    assert (await client.get("/api/v1/settings/library-scan")).status_code == 401
    assert (await client.post("/api/v1/settings/library-scan")).status_code == 401


@pytest.mark.asyncio
@pytest.mark.parametrize("interval", [0, -1])
async def test_disabled_auto_scan_does_not_start(monkeypatch, interval):
    from unittest.mock import AsyncMock

    from app.library_scan import library_scan_loop

    scan = AsyncMock()
    sleep = AsyncMock()
    monkeypatch.setattr("app.library_scan.settings.library_scan_interval_seconds", interval)
    monkeypatch.setattr("app.library_scan.scan_media_library", scan)
    monkeypatch.setattr("app.library_scan.asyncio.sleep", sleep)
    await library_scan_loop()
    scan.assert_not_awaited()
    sleep.assert_not_awaited()


@pytest.mark.asyncio
async def test_existing_database_migration_is_repeatable(monkeypatch):
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    from app.database import init_database

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.execute(
            text(
                "CREATE TABLE show_artwork (id INTEGER PRIMARY KEY, source_id INTEGER, "
                "directory TEXT, "
                "poster_path TEXT, fanart_path TEXT, clearlogo_path TEXT, status TEXT, "
                "last_error TEXT, scraped_at DATETIME)"
            )
        )
    monkeypatch.setattr("app.database.engine", engine)
    try:
        await init_database()
        await init_database()
        async with engine.begin() as connection:
            columns = await connection.execute(text("PRAGMA table_info(show_artwork)"))
            assert "file_version" in {row[1] for row in columns}
            assert (
                await connection.execute(
                    text(
                        "SELECT COUNT(*) FROM episode_thumbnails",
                    )
                )
            ).scalar() == 0
    finally:
        await engine.dispose()
