"""只读扫描作品目录，以实际视频文件构建季度和集数视图。"""

import os
import re
from datetime import UTC, datetime
from pathlib import Path

from .download_queue import VIDEO_EXTENSIONS
from .release_parser import parse_release_title
from .schemas import ShowEpisodeRead, ShowLibraryRead, ShowSeasonRead

SEASON_DIRECTORY = re.compile(r"(?i)(?:season[ ._-]*|s)(\d{1,2})|第\s*(\d{1,2})\s*季")
EXPLICIT_SEASON = re.compile(r"(?i)(?<![a-z0-9])s(\d{1,2})e\d")


def directory_season(name: str) -> int | None:
    if name.casefold() in {"specials", "special", "特别篇"}:
        return 0
    match = SEASON_DIRECTORY.fullmatch(name)
    return int(match.group(1) or match.group(2)) if match else None


def scan_show_library(
    directory: Path, preferred_season: int | None, movie: bool = False,
) -> ShowLibraryRead:
    """不轮询下载器、不使用下载计划虚构文件，不跟随子目录链接。"""
    if not directory.exists():
        return ShowLibraryRead(available=False, seasons=[], total=0)
    if not directory.is_dir():
        raise OSError("作品路径不是文件夹")
    groups: dict[int | None, list[ShowEpisodeRead]] = {}
    partial = False

    def visit(folder: Path, inherited: int | None) -> None:
        nonlocal partial
        try:
            with os.scandir(folder) as entries:
                for entry in entries:
                    if entry.name.startswith("."):
                        continue
                    path = Path(entry.path)
                    try:
                        if entry.is_symlink() or path.is_junction():
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            season = directory_season(entry.name)
                            visit(path, season if season is not None else inherited)
                        elif (entry.is_file(follow_symlinks=False)
                              and path.suffix.lower() in VIDEO_EXTENSIONS):
                            parsed = parse_release_title(path.stem)
                            explicit = EXPLICIT_SEASON.search(path.stem)
                            season = None if movie else inherited
                            if not movie and season is None:
                                season = int(explicit.group(1)) if explicit else preferred_season
                            stat = entry.stat(follow_symlinks=False)
                            groups.setdefault(season, []).append(ShowEpisodeRead(
                                path=path.relative_to(directory).as_posix(), filename=entry.name,
                                season=season,
                                episode_start=None if movie else parsed.episode_start,
                                episode_end=None if movie else parsed.episode_end,
                                size=stat.st_size,
                                modified_at=datetime.fromtimestamp(stat.st_mtime, UTC),
                            ))
                    except (OSError, ValueError):
                        partial = True
        except OSError:
            if folder == directory:
                raise
            partial = True

    visit(directory, None)
    seasons = []
    for season, items in sorted(groups.items(), key=lambda pair: (
        pair[0] is None, pair[0] if pair[0] is not None else 0,
    )):
        items.sort(key=lambda item: (
            item.episode_start is None,
            item.episode_start if item.episode_start is not None else 0,
            item.episode_end if item.episode_end is not None else 0,
            item.path.casefold(), item.path,
        ))
        seasons.append(ShowSeasonRead(season=season, items=items))
    return ShowLibraryRead(
        available=True, partial=partial, seasons=seasons,
        total=sum(len(group.items) for group in seasons),
    )
