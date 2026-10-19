"""扫描已订阅作品的本地图片；不读取 NFO、不识别或修改作品关联。"""

import asyncio
import hashlib
import json
import logging
import os
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends
from sqlalchemy import select

from .artwork_service import safe_folder_name
from .config import settings
from .database import SessionFactory
from .dependencies import require_user
from .download_queue import VIDEO_EXTENSIONS
from .events import commit_and_publish, record_event
from .library import get_library_root
from .models import BackgroundOperation, EpisodeThumbnail, FeedSource, ShowArtwork

router = APIRouter(prefix="/api/v1/settings/library-scan", dependencies=[Depends(require_user)])
logger = logging.getLogger(__name__)
scan_lock = asyncio.Lock()
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
ARTWORK_NAMES = {
    "poster": ("poster", "folder", "cover"),
    "fanart": ("fanart", "backdrop", "background"),
    "clearlogo": ("clearlogo", "logo"),
}
scan_state = {
    "running": False, "started_at": None, "finished_at": None,
    "scanned": 0, "changed": 0, "thumbnails": 0, "errors": 0,
}


@dataclass
class ImageFile:
    path: str
    modified_ns: int
    size: int

    @property
    def version(self) -> str:
        return hashlib.sha256(
            f"{self.path}|{self.modified_ns}|{self.size}".encode(),
        ).hexdigest()[:24]


@dataclass
class LibraryImages:
    artwork: dict[str, ImageFile | None]
    thumbnails: dict[str, ImageFile]
    partial: bool = False

    @property
    def version(self) -> str:
        return hashlib.sha256(json.dumps(
            {kind: image.version if image else None for kind, image in self.artwork.items()},
            sort_keys=True,
        ).encode()).hexdigest()[:24]


def local_image(directory: Path, relative: str) -> Path:
    """只允许作品目录内的普通图片，不跟随符号链接和 Windows 目录联接。"""
    path = Path(relative)
    if path.is_absolute() or path.drive or any(
        part in {".", ".."} or part.startswith(".") for part in path.parts
    ):
        raise ValueError("图片路径无效")
    current = directory
    for part in path.parts:
        current /= part
        if current.is_symlink() or current.is_junction():
            raise ValueError("图片路径不能包含链接")
    current.resolve().relative_to(directory.resolve())
    if current.suffix.lower() not in IMAGE_EXTENSIONS or not current.is_file():
        raise FileNotFoundError(relative)
    return current


def scan_images(directory: Path) -> LibraryImages:
    """只读文件名、大小和修改时间；单集图片必须与同目录真实视频同名。"""
    result = LibraryImages({kind: None for kind in ARTWORK_NAMES}, {})

    def visit(folder: Path) -> None:
        images: dict[str, ImageFile] = {}
        videos: list[Path] = []
        children: list[Path] = []
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
                            children.append(path)
                        elif entry.is_file(follow_symlinks=False):
                            suffix = path.suffix.lower()
                            if suffix in IMAGE_EXTENSIONS:
                                stat = entry.stat(follow_symlinks=False)
                                if stat.st_size:
                                    images[entry.name.casefold()] = ImageFile(
                                        path.relative_to(directory).as_posix(),
                                        stat.st_mtime_ns, stat.st_size,
                                    )
                            elif suffix in VIDEO_EXTENSIONS:
                                videos.append(path)
                    except OSError:
                        result.partial = True
        except OSError:
            if folder == directory:
                raise
            result.partial = True
            return
        by_stem: dict[str, ImageFile] = {}
        for name, image in images.items():
            stem = Path(name).stem
            previous = by_stem.get(stem)
            if previous is None or (image.modified_ns, image.path) > (
                previous.modified_ns, previous.path,
            ):
                by_stem[stem] = image
        if folder == directory:
            for kind, names in ARTWORK_NAMES.items():
                for name in names:
                    if name in by_stem:
                        result.artwork[kind] = by_stem[name]
                        break
        for video in videos:
            # Emby 的 <视频名>-thumb.jpg 优先，其次兼容 <视频名>.jpg。
            for stem in (f"{video.stem}-thumb", video.stem):
                image = by_stem.get(stem.casefold())
                if image:
                    result.thumbnails[video.relative_to(directory).as_posix()] = image
                    break
        for child in children:
            visit(child)

    visit(directory)
    return result


def binding(source: FeedSource, root: str) -> tuple:
    artwork = source.artwork
    directory = artwork.directory if artwork else str(Path(root) / safe_folder_name(source.name))
    return (source.name, directory, artwork.scraped_at if artwork else None,
            artwork.file_version if artwork else None,
            tuple(getattr(artwork, f"{kind}_path") for kind in ARTWORK_NAMES) if artwork else ())


async def source_busy(session, source_id: int) -> bool:
    return bool(await session.scalar(select(BackgroundOperation.id).where(
        BackgroundOperation.source_id == source_id,
        BackgroundOperation.status.in_({"queued", "running"}),
    ).limit(1)))


async def scan_source(source_id: int) -> tuple[bool, int]:
    # 文件系统扫描期间不持有数据库会话；提交前重新检查，避免覆盖并行上传、刮削或改名。
    async with SessionFactory() as session:
        source = await session.get(FeedSource, source_id)
        if source is None or await source_busy(session, source_id):
            return False, 0
        root = await get_library_root(session)
        before = binding(source, root)
    images = await asyncio.to_thread(scan_images, Path(before[1]))
    async with SessionFactory() as session:
        source = await session.get(FeedSource, source_id)
        if (source is None or binding(source, await get_library_root(session)) != before
                or await source_busy(session, source_id)):
            return False, 0
        artwork = source.artwork
        changed = False
        if artwork is None:
            artwork = ShowArtwork(source_id=source_id, directory=before[1])
            session.add(artwork)
            changed = True
        for kind, image in images.artwork.items():
            if image:
                value = str(Path(before[1]) / image.path)
                if getattr(artwork, f"{kind}_path") != value:
                    setattr(artwork, f"{kind}_path", value)
                    changed = True
        if artwork.file_version != images.version:
            artwork.file_version = images.version
            changed = True
        if not images.partial:
            # 缺图时保留旧路径，Emby 暂时删除后重新写回仍可恢复。
            # ready 标记检查真实文件；版本包含缺失状态，确保前端及时刷新。
            ready = sum(image is not None for image in images.artwork.values())
            status = "completed" if ready == 3 else "partial" if ready else "missing"
            error = "本地缺少：" + "、".join(
                kind for kind, image in images.artwork.items() if image is None
            ) if ready != 3 else None
            if artwork.status != status or artwork.last_error != error:
                changed = True
                artwork.status = status
                artwork.last_error = error
        saved = {item.video_path: item for item in await session.scalars(
            select(EpisodeThumbnail).where(EpisodeThumbnail.source_id == source_id),
        )}
        for video_path, image in images.thumbnails.items():
            item = saved.pop(video_path, None)
            if item is None:
                session.add(EpisodeThumbnail(source_id=source_id, video_path=video_path,
                                             image_path=image.path, file_version=image.version))
                changed = True
            elif item.image_path != image.path or item.file_version != image.version:
                item.image_path, item.file_version = image.path, image.version
                changed = True
        if not images.partial:
            for item in saved.values():
                await session.delete(item)
                changed = True
        if changed:
            record_event(session, "library.scan.changed", "feed_source", source_id, {
                "name": source.name, "thumbnails": len(images.thumbnails),
            })
            await commit_and_publish(session)
        return changed, len(images.thumbnails)


async def scan_media_library() -> None:
    if scan_lock.locked():
        return
    async with scan_lock:
        scan_state.update(running=True, started_at=datetime.now(UTC).isoformat(),
                          finished_at=None, scanned=0, changed=0, thumbnails=0, errors=0)
        try:
            async with SessionFactory() as session:
                ids = list(await session.scalars(select(FeedSource.id)))
            for source_id in ids:
                try:
                    changed, count = await scan_source(source_id)
                    scan_state["scanned"] += 1
                    scan_state["changed"] += int(changed)
                    scan_state["thumbnails"] += count
                except OSError:
                    # 未挂载、权限不足或目录消失时保留已有数据库记录。
                    scan_state["errors"] += 1
                    logger.warning("作品 %s 的图片扫描跳过：目录暂时无法读取", source_id)
                except Exception:
                    scan_state["errors"] += 1
                    logger.exception("作品 %s 的图片扫描失败", source_id)
        finally:
            scan_state.update(running=False, finished_at=datetime.now(UTC).isoformat())


async def library_scan_loop() -> None:
    await asyncio.sleep(5)
    while True:
        try:
            await scan_media_library()
        except Exception:
            logger.exception("媒体库图片扫描失败，稍后重试")
        await asyncio.sleep(max(10, settings.library_scan_interval_seconds))


@router.get("")
async def get_scan_status():
    return {**scan_state, "interval_seconds": max(10, settings.library_scan_interval_seconds)}


@router.post("", status_code=202)
async def request_scan(background_tasks: BackgroundTasks):
    background_tasks.add_task(scan_media_library)
    return {"message": "已提交媒体库图片扫描"}
