"""只允许访问配置媒体库中的普通文件，媒体身份绑定高精度文件版本。"""

import asyncio
import hashlib
import json
import re
import stat
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath

from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..artwork_service import safe_folder_name
from ..library import get_library_root
from ..models import DownloadJob, FeedItem, FeedSource, MediaFile
from ..schemas import ShowLibraryRead


class MediaError(Exception):
    def __init__(self, code: str, message: str, status: int = 409):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


@dataclass(frozen=True)
class ResolvedMedia:
    media_id: str
    source_id: int
    path: Path
    version: str
    size: int
    mtime_ns: int
    library_root: Path
    directory: Path
    relative_path: str
    probe_json: str | None = None


def safe_relative(value: str) -> PurePosixPath:
    # 同时按 Windows 与 POSIX 规则检查，避免容器接受宿主机危险路径。
    if (not value or len(value) > 4096 or "\\" in value or ":" in value
            or "\x00" in value or PureWindowsPath(value).drive):
        raise MediaError("unsafe_path", "媒体路径不安全", 403)
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in value.split("/")):
        raise MediaError("unsafe_path", "媒体路径不安全", 403)
    if any(part.rstrip(" .") != part or re.match(
        r"(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", part,
    ) for part in path.parts):
        raise MediaError("unsafe_path", "媒体路径不安全", 403)
    return path


def _ordinary_chain(path: Path) -> None:
    for part in [*reversed(path.parents), path]:
        info = part.lstat()
        if (stat.S_ISLNK(info.st_mode) or part.is_junction()
                or getattr(info, "st_file_attributes", 0) & 0x400):
            raise MediaError("unsafe_path", "媒体路径不能包含符号链接或重解析点", 403)


def safe_file(root: Path, directory: Path, relative: str) -> Path:
    relative_path = safe_relative(relative)
    root, directory = root.absolute(), directory.absolute()
    try:
        directory.relative_to(root)
        _ordinary_chain(root)
        _ordinary_chain(directory)
        candidate = directory.joinpath(*relative_path.parts)
        _ordinary_chain(candidate)
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(directory.resolve(strict=True))
        resolved.relative_to(root.resolve(strict=True))
        if not resolved.is_file():
            raise MediaError("media_unreadable", "媒体文件不可读取", 404)
        return resolved
    except MediaError:
        raise
    except ValueError as exc:
        raise MediaError("unsafe_path", "媒体文件必须位于配置媒体库和作品目录内", 403) from exc
    except (OSError, RuntimeError) as exc:
        raise MediaError("media_unreadable", "媒体文件不存在或暂时不可读取", 404) from exc


def file_version(relative: str, size: int, mtime_ns: int) -> str:
    return hashlib.sha256(f"{relative}\0{size}\0{mtime_ns}".encode()).hexdigest()


def ensure_current(media: ResolvedMedia) -> None:
    path = safe_file(media.library_root, media.directory, media.relative_path)
    info = path.stat()
    if file_version(media.relative_path, info.st_size, info.st_mtime_ns) != media.version:
        raise MediaError("media_changed", "媒体文件已替换，请刷新分集列表后重新播放")


async def register_library_media(
    session: AsyncSession, source_id: int, library: ShowLibraryRead, directory: Path,
) -> None:
    """扫描登记身份并异步排队预热；不等待 FFprobe，不安全文件无播放入口。"""
    root = Path(await get_library_root(session))
    values = []
    for group in library.seasons:
        for episode in group.items:
            try:
                path = await asyncio.to_thread(safe_file, root, directory, episode.path)
                info = await asyncio.to_thread(path.stat)
            except MediaError:
                continue
            version = file_version(episode.path, info.st_size, info.st_mtime_ns)
            media_id = hashlib.sha256(f"{source_id}\0{version}".encode()).hexdigest()
            values.append(dict(id=media_id, source_id=source_id, relative_path=episode.path,
                               file_version=version, size=info.st_size,
                               mtime_ns=str(info.st_mtime_ns)))
            episode.media_id = media_id
    # 批量身份登记允许并发列表请求，SQLite 主键冲突不会覆盖已有探测缓存。
    for offset in range(0, len(values), 100):
        await session.execute(insert(MediaFile).values(values[offset:offset + 100])
                              .on_conflict_do_nothing(index_elements=["id"]))
    if values:
        await session.commit()
        from .metadata import prewarmer

        prewarmer.schedule([value["id"] for value in values])


async def resolve_media(session: AsyncSession, media_id: str) -> ResolvedMedia:
    if not re.fullmatch(r"[a-f0-9]{64}", media_id):
        raise MediaError("media_not_found", "媒体不存在", 404)
    item = await session.get(MediaFile, media_id)
    source = await session.get(FeedSource, item.source_id) if item else None
    if item is None or source is None:
        raise MediaError("media_not_found", "媒体不存在，请刷新分集列表", 404)
    from .leases import ensure_source_available

    ensure_source_available(source.id)
    # 重启后仍按持久化计划判断，needs_review 也可能已经移动了一半。
    jobs = await session.scalars(select(DownloadJob).join(FeedItem).where(
        FeedItem.source_id == source.id,
    ))
    for job in jobs:
        pending = job.state in {"moving", "replacing", "season_changing"}
        if job.plan:
            try:
                plan = json.loads(job.plan)
            except ValueError:
                plan = {}
            replacement = plan.get("replacement", {})
            pending = pending or bool(plan.get("episode_rename") or plan.get("season_change"))
            pending = pending or bool(
                replacement and replacement.get("phase") not in {
                    "downloading", "done", "rolled_back",
                }
            )
        if pending:
            raise MediaError("media_migrating", "媒体文件正在迁移或替换，请稍后重试")
    root = Path(await get_library_root(session))
    directory = Path(source.artwork.directory) if source.artwork else (
        root / safe_folder_name(source.name)
    )
    path = await asyncio.to_thread(safe_file, root, directory, item.relative_path)
    media = ResolvedMedia(item.id, item.source_id, path, item.file_version, item.size,
                          int(item.mtime_ns), root, directory, item.relative_path, item.probe_json)
    await asyncio.to_thread(ensure_current, media)
    return media
