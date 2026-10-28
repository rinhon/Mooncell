import subprocess

import pytest

from app.artwork_service import _related_title, clearlogo_background, safe_folder_name


def test_safe_folder_name_removes_windows_invalid_characters() -> None:
    assert safe_folder_name("死神:千年血战篇?/Season*1.") == "死神_千年血战篇__Season_1"


def test_safe_folder_name_never_returns_empty_name() -> None:
    assert safe_folder_name("...") == "未命名番剧"


def test_related_title_accepts_exact_and_franchise_candidates() -> None:
    name = "死神 千年血战篇-祸进谭-"
    assert _related_title(name, "死神 千年血战篇 -祸进谭-")
    assert _related_title(name, "死神")
    assert not _related_title(name, "海贼王")


@pytest.mark.parametrize(
    "color, expected",
    [
        ("black", "light"),
        ("#303030", "light"),
        ("white", "dark"),
        ("#d04040", "dark"),
    ],
)
def test_clearlogo_background_ignores_transparent_padding(tmp_path, color, expected):
    path = tmp_path / "logo.png"
    subprocess.run(
        [
            "magick",
            "-size",
            "200x100",
            "xc:none",
            "-fill",
            color,
            "-draw",
            "rectangle 80,35 120,65",
            str(path),
        ],
        check=True,
    )
    assert clearlogo_background(str(path)) == expected


def test_clearlogo_background_rechecks_replaced_file_and_handles_empty_images(tmp_path):
    path = tmp_path / "logo.png"
    for color, expected in [("black", "light"), ("white", "dark"), ("none", "dark")]:
        subprocess.run(["magick", "-size", "16x12", f"xc:{color}", str(path)], check=True)
        assert clearlogo_background(str(path)) == expected
    assert clearlogo_background(str(tmp_path / "missing.png")) == "dark"
