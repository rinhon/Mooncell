import os
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.dependencies import require_user
from app.models import FeedSource, ShowArtwork
from app.show_library import scan_show_library


def video(root, path):
    target = root / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b"video")


def test_actual_files_group_seasons_and_sort_decimal_episodes(tmp_path):
    for name in [
        "Season 02/作品 S02E12.mkv",
        "Season 02/作品 S02E02.mkv",
        "Season 02/作品 S02E01.mkv",
        "Season 02/作品 S02E01.5.mkv",
        "Season 01/作品 S01E01.mp4",
        "Specials/作品 S00E00.mkv",
        "未识别视频.mkv",
        "Season 02/作品 S02E02.mkv.!qB",
        "Season 02/作品 S02E01.ass",
        ".mooncell/作品 S02E99.mkv",
        "poster.jpg",
    ]:
        video(tmp_path, name)
    result = scan_show_library(tmp_path, 2)
    assert result.available and not result.partial and result.total == 7
    assert [group.season for group in result.seasons] == [0, 1, 2]
    assert [item.episode_start for item in result.seasons[2].items] == [1, 1.5, 2, 12, None]
    assert result.seasons[2].items[-1].filename == "未识别视频.mkv"
    assert all(
        not Path(item.path).is_absolute() for group in result.seasons for item in group.items
    )


def test_no_files_are_invented_from_collection_range(tmp_path):
    result = scan_show_library(tmp_path, 2)
    assert result.total == 0 and result.seasons == [] and result.available
    video(tmp_path, "Season 02/合集 [01-12].mkv")
    result = scan_show_library(tmp_path, 2)
    assert result.total == 1 and len(result.seasons[0].items) == 1
    assert result.seasons[0].items[0].episode_start == 1
    assert result.seasons[0].items[0].episode_end == 12


@pytest.mark.parametrize("birthtime", [None, 1_800_000_000])
def test_episode_added_time_prefers_creation_time_and_falls_back_to_modified(
    tmp_path,
    monkeypatch,
    birthtime,
):
    video(tmp_path, "作品 S01E01.mkv")
    path = tmp_path / "作品 S01E01.mkv"
    modified = 1_700_000_000
    os.utime(path, (modified, modified))
    stat = SimpleNamespace(st_size=5, st_mtime=modified, st_ctime=1_900_000_000)
    if birthtime is not None:
        stat.st_birthtime = birthtime
    entry = MagicMock(name=path.name)
    entry.name, entry.path = path.name, str(path)
    entry.is_symlink.return_value = False
    entry.is_dir.return_value = False
    entry.is_file.return_value = True
    entry.stat.return_value = stat
    entries = MagicMock()
    entries.__enter__.return_value = [entry]
    monkeypatch.setattr("app.show_library.os.scandir", lambda _: entries)

    item = scan_show_library(tmp_path, 1).seasons[0].items[0]
    assert item.modified_at == datetime.fromtimestamp(modified, UTC)
    assert item.added_at == datetime.fromtimestamp(birthtime or modified, UTC)


def test_missing_folder_and_movie_and_unknown_season(tmp_path):
    assert not scan_show_library(tmp_path / "missing", 2).available
    video(tmp_path, "电影 (2026).mkv")
    result = scan_show_library(tmp_path, None, movie=True)
    assert result.seasons[0].season is None
    assert result.seasons[0].items[0].episode_start is None
    result = scan_show_library(tmp_path, None)
    assert result.seasons[0].season is None


def test_scanner_does_not_follow_links(tmp_path):
    library, outside = tmp_path / "library", tmp_path / "outside"
    library.mkdir()
    video(outside, "作品 S03E01.mkv")
    try:
        (library / "Season 03").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("当前系统未允许创建符号链接")
    assert scan_show_library(library, 2).total == 0


@pytest.mark.asyncio
async def test_library_route_source_folder_and_auth(show_client, tmp_path):
    client, sessions, app = show_client
    for episode in range(1, 14):
        video(tmp_path, f"Season 02/作品 S02E{episode:02}.mkv")
    async with sessions() as session:
        source = await session.get(FeedSource, 1)
        source.season = 2
        session.add(ShowArtwork(source_id=1, directory=str(tmp_path)))
        await session.commit()
    response = await client.get("/api/v1/shows/1/library")
    assert response.status_code == 200
    data = response.json()
    assert data["total"] == 13
    assert data["seasons"][0]["season"] == 2
    assert len(data["seasons"][0]["items"]) == 13
    assert (await client.get("/api/v1/shows/999/library")).status_code == 404
    app.dependency_overrides.pop(require_user)
    assert (await client.get("/api/v1/shows/1/library")).status_code == 401


@pytest.mark.asyncio
async def test_library_route_permission_error_is_retryable(show_client, monkeypatch, tmp_path):
    client, sessions, _ = show_client
    async with sessions() as session:
        session.add(ShowArtwork(source_id=1, directory=str(tmp_path)))
        await session.commit()

    def denied(*args):
        raise PermissionError

    monkeypatch.setattr("app.api.scan_show_library", denied)
    assert (await client.get("/api/v1/shows/1/library")).status_code == 403
