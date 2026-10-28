import pytest

from app.release_parser import parse_release_title


def test_parses_ani_release() -> None:
    release = parse_release_title(
        "[ANi] Sousou no Frieren - 05 [1080P][Baha][WEB-DL][AAC AVC][CHT]"
    )
    assert release.release_group == "ANi"
    assert release.title == "Sousou no Frieren"
    assert release.season == 1
    assert release.episode_start == 5
    assert release.resolution == "1080p"
    assert release.sources == ["WEB-DL", "Baha"]
    assert release.subtitle_languages == ["zh-Hant"]
    assert release.video_codecs == ["AVC"]
    assert release.audio_codecs == ["AAC"]


def test_revision_does_not_change_episode_identity() -> None:
    release = parse_release_title("[Group] Example Show - 06v2 [1080p]")
    assert release.episode_start == 6
    assert release.revision == 2


@pytest.mark.parametrize(
    "marker,episode,revision",
    [
        ("01", 1, 1),
        ("01v2", 1, 2),
        ("06V3", 6, 3),
        ("12.5v2", 12.5, 2),
    ],
)
def test_bracket_episode_and_revision(marker, episode, revision):
    release = parse_release_title(f"[Group] 中文 / Example [{marker}][1080P][简体内嵌]")
    assert release.title == "中文 / Example"
    assert release.episode_start == episode
    assert release.revision == revision
    assert release.confidence >= 0.9
    assert not release.warnings


def test_numeric_group_and_encoding_tags_are_not_episodes():
    release = parse_release_title("[123] Example [1080P][10bit][2026]")
    assert release.episode_start is None


def test_special_uses_season_zero() -> None:
    release = parse_release_title("[Group] Example Show OVA - 01 [1080p]")
    assert release.media_type == "ova"
    assert release.season == 0
    assert release.episode_start == 1


def test_collection_requires_review() -> None:
    release = parse_release_title("[Group] Example Show 01-12 Complete [1080p]")
    assert release.release_kind in {"range", "collection"}
    assert release.warnings


def test_youjo_senki_second_season() -> None:
    release = parse_release_title(
        "[LoliHouse] 幼女战记II / Youjo Senki II - 04 "
        "[WebRip 1080p HEVC-10bit AAC][简繁内封字幕](检索用：谭雅战记)"
    )
    assert release.season == 2
    assert release.episode_start == 4
    assert release.title == "幼女战记II / Youjo Senki II"
    assert "season:roman_suffix" in release.evidence


@pytest.mark.parametrize(
    "title,season",
    [
        ("幼女战记Ⅱ", 2),
        ("Example III", 3),
        ("Example IV", 4),
        ("Example VIII", 8),
        ("CLANNAD", 1),
        ("Example MIX", 1),
        ("Example II OVA", 0),
    ],
)
def test_roman_season_suffix_boundaries(title, season):
    assert parse_release_title(f"[Group] {title} - 04 [1080p]").season == season


def test_explicit_season_overrides_roman_title():
    assert parse_release_title("[Group] Example II S03E04 [1080p]").season == 3


def test_roman_numerals_outside_title_are_not_seasons():
    assert parse_release_title("[Group II] Example - 04 [1080p] (Search II)").season == 1
