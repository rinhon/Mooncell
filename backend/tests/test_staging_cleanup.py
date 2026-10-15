from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from app.staging_cleanup import cleanup_temporary_directories, prune_empty_directories


def test_prune_only_empty_directories_and_keep_protected_tree(tmp_path):
    root = tmp_path / ".mooncell"
    (root / "season-change" / "hash" / "token" / "Season 01").mkdir(parents=True)
    (root / "active" / "empty-child").mkdir(parents=True)
    (root / "leftover" / "empty-child").mkdir(parents=True)
    media = root / "leftover" / "video.mkv"
    media.write_bytes(b"unfinished-media")
    assert prune_empty_directories(root, [root / "active"]) == 5
    assert not (root / "season-change").exists()
    assert (root / "active" / "empty-child").is_dir()
    assert media.read_bytes() == b"unfinished-media"
    assert not (media.parent / "empty-child").exists()
    assert prune_empty_directories(root, [root / "active"]) == 0


def test_empty_root_removed_and_missing_root_is_idempotent(tmp_path):
    root = tmp_path / ".mooncell"
    (root / "a" / "b").mkdir(parents=True)
    assert prune_empty_directories(root) == 3
    assert not root.exists()
    assert prune_empty_directories(root) == 0
    assert tmp_path.is_dir()


@pytest.mark.parametrize("where", ["root", "child", "ancestor"])
def test_junctions_are_not_traversed(tmp_path, monkeypatch, where):
    root = tmp_path / ".mooncell"
    child = root / "junction"
    (child / "outside-empty").mkdir(parents=True)
    junction = {"root": root, "child": child, "ancestor": tmp_path}[where]
    monkeypatch.setattr(Path, "is_junction", lambda path: path == junction)
    assert prune_empty_directories(root) == 0
    assert (child / "outside-empty").is_dir()


def test_relative_path_and_symlinks_are_not_traversed(tmp_path, monkeypatch):
    root = tmp_path / ".mooncell"
    (root / "linked" / "outside-empty").mkdir(parents=True)
    linked = root / "linked"
    original = Path.is_symlink
    monkeypatch.setattr(Path, "is_symlink", lambda path: path == linked or original(path))
    assert prune_empty_directories(root) == 0
    assert (linked / "outside-empty").is_dir()
    monkeypatch.chdir(tmp_path)
    assert prune_empty_directories(Path(".mooncell")) == 0


async def test_mapped_remote_paths_and_qb_save_and_download_paths_are_protected(tmp_path):
    root = tmp_path / "library" / ".mooncell"
    for name in ("active-save", "active-download", "stale"):
        (root / name / "empty").mkdir(parents=True)
    config = SimpleNamespace(remote_download_root="/media", local_download_root=str(tmp_path))
    calls = []

    def handle(request):
        calls.append(request.url.path)
        return httpx.Response(200, json=[{
            "save_path": "/media/library/.mooncell/active-save",
            "download_path": "/media/library/.mooncell/active-download",
        }, {"save_path": "/other/library"}])

    async with httpx.AsyncClient(base_url="http://qb.test",
                                 transport=httpx.MockTransport(handle)) as client:
        assert await cleanup_temporary_directories(client, "/media/library", config) == 2
    assert calls == ["/api/v2/torrents/info"]
    assert not (root / "stale").exists()
    assert (root / "active-save" / "empty").is_dir()
    assert (root / "active-download" / "empty").is_dir()


async def test_offline_downloader_does_not_remove_directories(tmp_path):
    root = tmp_path / ".mooncell"
    (root / "active-empty").mkdir(parents=True)
    config = SimpleNamespace(remote_download_root=None, local_download_root=None)
    async with httpx.AsyncClient(base_url="http://qb.test", transport=httpx.MockTransport(
        lambda request: httpx.Response(503),
    )) as client:
        assert await cleanup_temporary_directories(client, str(tmp_path), config) == 0
    assert (root / "active-empty").is_dir()


def test_file_created_before_rmdir_is_preserved(tmp_path, monkeypatch):
    root = tmp_path / ".mooncell"
    root.mkdir()
    original = Path.rmdir

    def create_file_then_remove(path):
        (path / "new.mkv").write_bytes(b"just-created")
        original(path)

    monkeypatch.setattr(Path, "rmdir", create_file_then_remove)
    assert prune_empty_directories(root) == 0
    assert (root / "new.mkv").read_bytes() == b"just-created"
