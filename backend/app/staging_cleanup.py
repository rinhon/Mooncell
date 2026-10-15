"""清理 .mooncell 内的空目录，不删除文件、不遍历链接或仍被下载器使用的目录。"""

import asyncio
import errno
import logging
from pathlib import Path

import httpx
from sqlalchemy import select

logger = logging.getLogger(__name__)


def prune_empty_directories(root, protected=()):
    root = Path(root)
    if not root.is_absolute() or any(
        path.is_symlink() or path.is_junction() for path in (root, *root.parents)
    ):
        return 0
    boundary = root.resolve()
    protected = [Path(path).resolve() for path in protected]
    removed = 0

    def prune(path):
        nonlocal removed
        if path.is_symlink() or path.is_junction():
            return
        resolved = path.resolve()
        if not resolved.is_relative_to(boundary) or any(
            resolved.is_relative_to(used) for used in protected
        ):
            return
        try:
            for child in path.iterdir():
                if child.is_dir():
                    prune(child)
            # rmdir 只接受空目录；检查后又出现文件时也不会删除文件。
            path.rmdir()
            removed += 1
        except OSError as exc:
            if exc.errno not in {errno.ENOENT, errno.ENOTEMPTY, errno.EEXIST}:
                logger.warning("无法清理暂存空目录 %s：%s", path, exc)

    prune(root)
    return removed


async def cleanup_temporary_directories(client, target_root, config, *, torrents=None):
    from .download_queue import path_type, request
    from .revision_upgrade import local_path

    try:
        remote_root = path_type(target_root)(target_root) / ".mooncell"
        root = local_path(str(remote_root), config)
        if not root.is_absolute() or not root.is_dir():
            return 0  # 远程下载器未配置可访问的路径映射时，不在本机猜测目录。
        if torrents is None:
            torrents = (await request(client, "GET", "torrents/info")).json()
        protected = []
        for torrent in torrents:
            for key in ("save_path", "download_path"):
                location = torrent.get(key)
                if location and path_type(location)(location).is_relative_to(remote_root):
                    protected.append(local_path(location, config))
        return await asyncio.to_thread(prune_empty_directories, root, protected)
    except (OSError, ValueError, httpx.HTTPError) as exc:
        # 清理失败不应把已完成的整理或迁移标为失败，后台会再次尝试。
        logger.warning("暂存空目录清理未完成：%s", type(exc).__name__)
        return 0


async def cleanup_stale_temporary_directories():
    """定期补清理历史空目录；下载器离线时保留，避免误清理仍在使用的目录。"""
    from .download_queue import SessionFactory, queue_lock, request
    from .models import DownloaderConfig, DownloadJob
    from .security import decrypt_secret

    removed = 0
    async with queue_lock:
        async with SessionFactory() as session:
            roots = list((await session.execute(select(
                DownloadJob.downloader_id, DownloadJob.target_root,
            ).distinct())).all())
            for downloader_id in {downloader_id for downloader_id, _ in roots}:
                config = await session.get(DownloaderConfig, downloader_id)
                if not config or not config.active or config.kind != "qbittorrent":
                    continue
                try:
                    async with httpx.AsyncClient(base_url=config.base_url, timeout=10,
                                                 verify=config.verify_tls) as client:
                        login = await request(client, "POST", "auth/login", data={
                            "username": config.username or "",
                            "password": decrypt_secret(config.encrypted_secret) or "",
                        })
                        if login.status_code != 204 and not login.text.startswith("Ok"):
                            continue
                        torrents = (await request(client, "GET", "torrents/info")).json()
                        for root_id, target_root in roots:
                            if root_id == downloader_id:
                                removed += await cleanup_temporary_directories(
                                    client, target_root, config, torrents=torrents,
                                )
                except (OSError, ValueError, httpx.HTTPError) as exc:
                    logger.warning("历史暂存空目录清理未完成：%s", type(exc).__name__)
    return removed
