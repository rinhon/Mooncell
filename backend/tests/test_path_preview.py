import os
from pathlib import Path, PurePosixPath, PureWindowsPath
from types import SimpleNamespace

import pytest

from app import api
from app.schemas import PathPreviewRequest


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("path_type", "root", "separator"),
    [(PureWindowsPath, "D:\\Media", "\\"), (PurePosixPath, "/media", "/")],
)
async def test_preview_platform_paths_without_year(monkeypatch, path_type, root, separator):
    monkeypatch.setattr(api, "Path", path_type)
    monkeypatch.setattr(api, "os", SimpleNamespace(sep=separator))
    result = await api.path_preview(PathPreviewRequest(library_root=root, year=2023))
    assert result.full_path == str(path_type(root) / "番名" / "Season 01" / "番名 S01E05.mkv")
    assert result.separator == separator
    assert result.folder_name == "番名"
    assert "2023" not in result.directory


@pytest.mark.asyncio
async def test_preview_uses_backend_platform(tmp_path):
    result = await api.path_preview(PathPreviewRequest(library_root=str(tmp_path)))
    assert result.separator == os.sep
    assert result.full_path == str(Path(tmp_path) / "番名" / "Season 01" / result.filename)
