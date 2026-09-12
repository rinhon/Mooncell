"""已认证的服务器文件夹浏览与媒体库路径设置。"""

import os
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from .config import settings
from .database import get_session
from .dependencies import require_user
from .models import LibrarySettings

router = APIRouter(prefix="/api/v1", dependencies=[Depends(require_user)])


class LibraryPath(BaseModel):
    library_root: str = Field(min_length=1, max_length=4096)


async def get_library_root(session: AsyncSession, fallback: str | None = None) -> str:
    saved = await session.get(LibrarySettings, 1)
    if saved:
        return saved.library_root
    return str(Path(fallback or settings.media_library_root).resolve())


def existing_directory(value: str) -> Path:
    try:
        path = Path(value)
        if not path.is_absolute():
            raise HTTPException(422, "请选择完整的文件夹路径")
        path = path.resolve(strict=True)
        if not path.is_dir():
            raise HTTPException(422, "所选路径不是文件夹")
        return path
    except PermissionError as exc:
        raise HTTPException(403, "没有权限访问此文件夹") from exc
    except (OSError, ValueError, RuntimeError) as exc:
        raise HTTPException(404, "文件夹不存在或无法访问") from exc


@router.get("/filesystem/directories")
def list_directories(path: str | None = None) -> dict:
    """只读取一层子文件夹，不递归扫描磁盘，不返回文件。"""
    if path is None:
        roots = os.listdrives() if os.name == "nt" else ["/"]
        return {"path": None, "children": [{"name": p, "path": p} for p in roots]}
    directory = existing_directory(path)
    try:
        children = []
        with os.scandir(directory) as entries:
            for entry in entries:
                try:
                    if entry.is_dir(follow_symlinks=False) and not Path(entry.path).is_junction():
                        children.append({"name": entry.name, "path": str(directory / entry.name)})
                except OSError:
                    continue
        return {"path": str(directory), "children": sorted(
            children, key=lambda item: item["name"].casefold(),
        )}
    except PermissionError as exc:
        raise HTTPException(403, "没有权限读取此文件夹") from exc
    except OSError as exc:
        raise HTTPException(400, "无法读取此文件夹，请刷新重试") from exc


@router.get("/settings/library", response_model=LibraryPath)
async def read_library(session: AsyncSession = Depends(get_session)) -> LibraryPath:
    return LibraryPath(library_root=await get_library_root(session))


@router.patch("/settings/library", response_model=LibraryPath)
async def save_library(
    data: LibraryPath, session: AsyncSession = Depends(get_session),
) -> LibraryPath:
    path = await run_in_threadpool(existing_directory, data.library_root)
    # 验证可以读取目录后才保存，失效路径不会覆盖已有设置。
    await run_in_threadpool(list_directories, str(path))
    saved = await session.get(LibrarySettings, 1)
    if saved is None:
        saved = LibrarySettings(id=1, library_root=str(path))
        session.add(saved)
    else:
        saved.library_root = str(path)
    await session.commit()
    return LibraryPath(library_root=saved.library_root)
