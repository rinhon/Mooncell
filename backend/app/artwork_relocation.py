"""番名变更时复制已有三图并切换引用，保留原图供共享旧目录的订阅使用。"""

import asyncio
import hashlib
import shutil
from datetime import UTC, datetime
from pathlib import Path

from .artwork_service import safe_folder_name


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").digest()


def copy_files(copies):
    # 先检查所有目标，再复制。使用独占创建，绝不覆盖另一个订阅的图片。
    for original, target in copies:
        if target.exists() and digest(original) != digest(target):
            raise ValueError(f"新番剧目录已有不同的图片，未覆盖：{target.name}")
    for original, target in copies:
        if target.exists():
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            output = target.open("xb")
        except FileExistsError:
            if digest(original) != digest(target):
                raise ValueError(f"新番剧目录已有不同的图片，未覆盖：{target.name}") from None
            continue
        try:
            with output, original.open("rb") as stream:
                shutil.copyfileobj(stream, output)
        except OSError:
            # 只移除本次独占创建的未完成副本，原图片始终保留。
            target.unlink(missing_ok=True)
            raise


async def copy_artwork_for_rename(source):
    artwork = source.artwork
    if artwork is None:
        return
    original_directory = Path(artwork.directory).resolve()
    target_directory = original_directory.parent / safe_folder_name(source.name)
    if target_directory.resolve().parent != original_directory.parent:
        raise ValueError("新番剧图片目录超出原媒体库范围，请检查目录映射")
    if target_directory == original_directory:
        return
    paths = {}
    copies = []
    for field in ("poster_path", "fanart_path", "clearlogo_path"):
        value = getattr(artwork, field)
        if not value:
            continue
        original = Path(value).resolve()
        if original.parent != original_directory:
            raise ValueError("原图片路径不在番剧目录内，请先检查图片记录")
        target = target_directory / original.name
        paths[field] = str(target)
        if original.is_file():
            copies.append((original, target))
        elif target.exists():
            raise ValueError(f"原图片丢失且新目录已有同名图片，请先核对：{target.name}")
    await asyncio.to_thread(copy_files, copies)
    artwork.directory = str(target_directory)
    for field, value in paths.items():
        setattr(artwork, field, value)
    artwork.scraped_at = datetime.now(UTC)
