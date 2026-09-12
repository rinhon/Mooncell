from app.artwork_service import _related_title, safe_folder_name


def test_safe_folder_name_removes_windows_invalid_characters() -> None:
    assert safe_folder_name('死神:千年血战篇?/Season*1.') == "死神_千年血战篇__Season_1"


def test_safe_folder_name_never_returns_empty_name() -> None:
    assert safe_folder_name("...") == "未命名番剧"


def test_related_title_accepts_exact_and_franchise_candidates() -> None:
    name = "死神 千年血战篇-祸进谭-"
    assert _related_title(name, "死神 千年血战篇 -祸进谭-")
    assert _related_title(name, "死神")
    assert not _related_title(name, "海贼王")
