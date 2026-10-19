"""将动漫发布标题转换为可执行、可解释的结构化信息。"""

import re
import unicodedata
from pathlib import PurePath

from .schemas import ParsedRelease

GROUP_RE = re.compile(r"^\s*\[([^\]]+)]")
SEASON_EPISODE_RE = re.compile(
    r"\bS(?P<season>\d{1,2})\s*E(?P<episode>\d+(?:\.\d+)?)(?:v(?P<revision>\d+))?\b",
    re.IGNORECASE,
)
DASH_EPISODE_RE = re.compile(
    r"\s[-–—]\s*(?P<episode>\d+(?:\.\d+)?)(?:v(?P<revision>\d+))?(?=\s|\[|$)",
    re.IGNORECASE,
)
BRACKET_EPISODE_RE = re.compile(
    r"\[(?P<episode>\d{1,3}(?:\.\d+)?)(?:v(?P<revision>[1-9]\d*))?]",
    re.IGNORECASE,
)
RANGE_RE = re.compile(r"\b(?:E)?(?P<start>\d{1,3})\s*[-~]\s*(?:E)?(?P<end>\d{1,3})\b")
RESOLUTION_RE = re.compile(r"\b(2160|1440|1080|720|480)[pP]\b")
BRACKET_RE = re.compile(r"\[[^\]]+]|【[^】]+】")
ROMAN_SEASONS = {"II": 2, "III": 3, "IV": 4, "V": 5, "VI": 6,
                 "VII": 7, "VIII": 8, "IX": 9, "X": 10}
ROMAN_SEASON_RE = re.compile(
    r"(?:\s|(?<=[\u3400-\u9fff]))(VIII|VII|III|VI|IV|IX|II|V|X)$"
)


def _unique_matches(raw: str, values: dict[str, tuple[str, ...]]) -> list[str]:
    """匹配同一属性的多种常见别名，并返回规范化名称。"""
    upper = raw.upper()
    return [
        normalized
        for normalized, aliases in values.items()
        if any(alias in upper for alias in aliases)
    ]


def _media_type(raw: str) -> tuple[str, list[str]]:
    """优先识别不能按普通季度剧集处理的特殊媒体类型。"""
    upper = raw.upper()
    checks = [
        ("opening", ("NCOP", " OPENING ")),
        ("ending", ("NCED", " ENDING ")),
        ("pv", (" PV ", "[PV]", "PROMOTION VIDEO", " CM ")),
        ("movie", ("剧场版", "劇場版", "GEKIJOU", "[MOVIE]", " MOVIE ")),
        ("ova", ("OVA",)),
        ("oad", ("OAD",)),
        ("special", ("SPECIAL", "[SP]", " SP ")),
    ]
    for media_type, tokens in checks:
        if any(token in upper for token in tokens):
            return media_type, [f"media_type:{media_type}"]
    return "episode", []


def parse_release_title(raw_title: str) -> ParsedRelease:
    """解析字幕组、番剧名、季集、来源、编码等信息，并计算置信度。"""
    raw = " ".join(raw_title.strip().split())
    evidence: list[str] = []
    warnings: list[str] = []

    # 常见发布名以 `[字幕组]` 开头；保留该信息供订阅偏好排序使用。
    group_match = GROUP_RE.search(raw)
    group = group_match.group(1).strip() if group_match else None
    if group:
        evidence.append("release_group")

    media_type, media_evidence = _media_type(f" {raw} ")
    evidence.extend(media_evidence)

    season = 1 if media_type in {"episode", "unknown"} else None
    episode_start: float | None = None
    episode_end: float | None = None
    revision = 1
    # SxxExx 比「- 05」表达更明确，因此必须优先匹配。
    episode_match = SEASON_EPISODE_RE.search(raw)
    if episode_match:
        season = int(episode_match.group("season"))
        episode_start = float(episode_match.group("episode"))
        revision = int(episode_match.group("revision") or 1)
        evidence.extend(["season", "episode"])
    else:
        episode_match = DASH_EPISODE_RE.search(raw) or BRACKET_EPISODE_RE.search(
            raw, group_match.end() if group_match else 0
        )
        if episode_match:
            episode_start = float(episode_match.group("episode"))
            revision = int(episode_match.group("revision") or 1)
            evidence.append("episode")

    # 范围包和合集不能安全映射成单一剧集，后续需要逐文件确认。
    range_match = RANGE_RE.search(raw)
    release_kind = "single"
    if (range_match and (episode_match is None or range_match.start() != episode_match.start())
            and not (episode_match and range_match.end() == episode_match.end())):
        release_kind = "range"
        episode_start = float(range_match.group("start"))
        episode_end = float(range_match.group("end"))
        evidence.append("episode_range")
    elif re.search(r"\b(BATCH|COMPLETE|COLLECTION)\b|全集|合集", raw, re.IGNORECASE):
        release_kind = "collection"
        evidence.append("collection")

    if media_type in {"ova", "oad", "special"}:
        season = 0

    title_source = raw[group_match.end() :] if group_match else raw
    title_end = (
        episode_match.start() - (group_match.end() if group_match else 0) if episode_match else None
    )
    if title_end is not None and title_end > 0:
        title_source = title_source[:title_end]
    else:
        title_source = BRACKET_RE.sub(" ", title_source)
    title = " ".join(title_source.strip(" -–—_").split()) or None
    if title:
        evidence.append("title")
        # 仅识别标题末尾的独立罗马数字；不读取字幕组、编码或检索备注。
        # SxxExx 的明确季度优先，OVA/特别篇仍使用第 0 季。
        if "season" not in evidence and media_type == "episode":
            roman_title = unicodedata.normalize("NFKC", title)
            roman_match = ROMAN_SEASON_RE.search(roman_title)
            if roman_match:
                season = ROMAN_SEASONS[roman_match.group(1)]
                evidence.append("season:roman_suffix")
    else:
        warnings.append("无法提取可用标题")

    resolution_match = RESOLUTION_RE.search(raw)
    resolution = f"{resolution_match.group(1)}p" if resolution_match else None
    if resolution:
        evidence.append("resolution")

    sources = _unique_matches(
        raw,
        {
            "WEB-DL": ("WEB-DL", "WEBDL"),
            "BluRay": ("BLURAY", "BLU-RAY", "BDRIP"),
            "Baha": ("BAHA",),
            "B-Global": ("B-GLOBAL", "BGLOBAL"),
        },
    )
    subtitle_languages = _unique_matches(
        raw,
        {
            "zh-Hans": ("CHS", "GB", "简体", "简日", "简中"),
            "zh-Hant": ("CHT", "BIG5", "繁体", "繁日", "繁中"),
            "zh": ("简繁", "GB&BIG5", "CHS&CHT"),
        },
    )
    video_codecs = _unique_matches(
        raw,
        {
            "AVC": ("AVC", "H.264", "H264"),
            "HEVC": ("HEVC", "H.265", "H265", "X265"),
            "AV1": ("AV1",),
        },
    )
    audio_codecs = _unique_matches(
        raw,
        {
            "AAC": ("AAC",),
            "FLAC": ("FLAC",),
            "EAC3": ("EAC3", "E-AC-3"),
            "OPUS": ("OPUS",),
        },
    )

    suffix = PurePath(raw).suffix.lower()
    container = suffix.lstrip(".") if suffix in {".mkv", ".mp4", ".ts", ".m2ts"} else None

    if media_type in {"episode", "ova", "oad", "special"} and episode_start is None:
        warnings.append("缺少明确集数，不能自动整理")
    if release_kind != "single":
        warnings.append("合集或范围发布需要逐文件审核")

    # 置信度是自动化闸门：信息不足的条目进入人工确认，不直接下载。
    confidence = 0.15
    confidence += 0.15 if group else 0
    confidence += 0.25 if title else 0
    confidence += 0.30 if episode_start is not None else 0
    confidence += 0.10 if resolution else 0
    confidence += 0.05 if media_evidence else 0
    confidence = min(round(confidence, 2), 1.0)

    return ParsedRelease(
        raw_title=raw_title,
        title=title,
        release_group=group,
        media_type=media_type,
        release_kind=release_kind,
        season=season,
        episode_start=episode_start,
        episode_end=episode_end,
        revision=revision,
        resolution=resolution,
        sources=sources,
        subtitle_languages=subtitle_languages,
        video_codecs=video_codecs,
        audio_codecs=audio_codecs,
        container=container,
        confidence=confidence,
        evidence=evidence,
        warnings=warnings,
    )
