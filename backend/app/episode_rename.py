"""通过 qBittorrent 改名；持久化请求以便响应丢失或重启后继续确认。"""

import asyncio
import hashlib
import json
import re
from contextlib import asynccontextmanager
from pathlib import Path, PurePosixPath

import httpx
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert

from .artwork_service import safe_folder_name
from .download_queue import path_type, remote_root, request
from .events import commit_and_publish, record_event
from .library import get_library_root
from .models import (
    DownloaderConfig,
    DownloadJob,
    EpisodeThumbnail,
    FeedItem,
    FeedSource,
    MediaFile,
    PlaybackProgress,
)
from .playback.leases import begin_mutation, finish_mutation, source_in_use
from .playback.media import MediaError, ensure_current, file_version, resolve_media, safe_file
from .playback.media import safe_relative as checked_relative
from .security import decrypt_secret


def validate_filename(filename: str, original: str) -> None:
    try:
        path = checked_relative(filename)
    except MediaError as exc:
        raise HTTPException(422, "文件名不能包含路径、保留名称或无效字符") from exc
    if (
        len(path.parts) != 1
        or filename.startswith(".")
        or re.search(r'[<>"|?*\x00-\x1f\x7f]', filename)
        or len(filename.encode("utf-8")) > 255
    ):
        raise HTTPException(422, "请输入有效的文件名，不能包含路径或无效字符")
    if path.suffix.lower() != PurePosixPath(original).suffix.lower():
        raise HTTPException(422, "请保留原视频扩展名")
    if filename == original:
        raise HTTPException(422, "文件名没有变化")
    if filename.casefold() == original.casefold():
        raise HTTPException(422, "暂不支持只修改文件名的大小写")


@asynccontextmanager
async def qb_client(config):
    async with httpx.AsyncClient(
        base_url=config.base_url,
        timeout=10,
        verify=config.verify_tls,
    ) as client:
        response = await request(
            client,
            "POST",
            "auth/login",
            data={
                "username": config.username or "",
                "password": decrypt_secret(config.encrypted_secret) or "",
            },
        )
        if response.status_code != 204 and not response.text.startswith("Ok"):
            raise HTTPException(502, "qBittorrent 拒绝登录，请检查下载器凭据")
        yield client


async def find_torrent_file(session, source_id, local_path):
    jobs = list(
        await session.scalars(
            select(DownloadJob)
            .join(FeedItem)
            .where(
                FeedItem.source_id == source_id,
                DownloadJob.state == "done",
            )
        )
    )
    matches = []
    for config_id in {job.downloader_id for job in jobs}:
        config = await session.get(DownloaderConfig, config_id)
        if not config or not config.active or config.kind != "qbittorrent":
            continue
        try:
            expected = remote_root(str(local_path), config)
        except ValueError:
            continue
        by_hash = {job.info_hash.lower(): job for job in jobs if job.downloader_id == config_id}
        async with qb_client(config) as client:
            torrents = (
                await request(
                    client,
                    "GET",
                    "torrents/info",
                    params={
                        "hashes": "|".join(by_hash),
                    },
                )
            ).json()
            for torrent in torrents:
                job = by_hash.get(str(torrent.get("hash", "")).lower())
                if job is None or not torrent.get("save_path"):
                    continue
                response = await request(
                    client, "GET", "torrents/files", params={"hash": job.info_hash}
                )
                for file in response.json():
                    name = str(file["name"]).replace("\\", "/")
                    relative = checked_relative(name)
                    location = path_type(torrent["save_path"])(torrent["save_path"])
                    actual = location.joinpath(*relative.parts)
                    if actual != path_type(expected)(expected):
                        continue
                    if torrent.get("state") == "moving" or float(file.get("progress", 0)) < 1:
                        raise HTTPException(409, "该视频正在下载或移动，请完成后再改名")
                    matches.append((job, config, file, name))
    if len(matches) != 1:
        message = (
            "多个下载任务指向此文件，请先处理下载器路径冲突"
            if matches
            else "找不到对应的 qBittorrent 任务，请确认下载器已启用、任务仍存在且路径映射正确"
        )
        raise HTTPException(409, message)
    return matches[0]


async def schedule_rename(session, source_id, media_id, filename):
    media = await resolve_media(session, media_id)
    if media.source_id != source_id:
        raise HTTPException(404, "此订阅中没有该视频")
    validate_filename(filename, media.path.name)
    if source_in_use(source_id):
        raise HTTPException(409, "该作品正在播放，请先关闭播放页面再改名")
    target = media.path.with_name(filename)
    if await asyncio.to_thread(
        lambda: any(
            entry.name.casefold() == filename.casefold() for entry in target.parent.iterdir()
        )
    ):
        raise HTTPException(409, "同一文件夹已有此文件名，请使用其他名称")
    job, config, file, old_name = await find_torrent_file(session, source_id, media.path)
    plan = json.loads(job.plan) if job.plan else {}
    replacement = plan.get("replacement", {})
    if (
        not plan.get("files")
        or plan.get("season_change")
        or replacement.get("phase", "done") not in {"done", "rolled_back"}
    ):
        raise HTTPException(409, "下载整理或版本替换尚未结束，请稍后重试")
    if not any(entry["new"] == old_name for entry in plan["files"]):
        raise HTTPException(409, "下载器文件名与整理记录不一致，请先重新整理该任务")
    await asyncio.to_thread(ensure_current, media)
    pending = {
        "media_id": media_id,
        "old": old_name,
        "new": str(PurePosixPath(old_name).with_name(filename)),
        "relative": media.relative_path,
        "target": str(PurePosixPath(media.relative_path).with_name(filename)),
        "index": int(file["index"]),
        "size": media.size,
        "mtime_ns": media.mtime_ns,
    }
    plan["episode_rename"] = pending
    job.plan, job.state, job.last_error = json.dumps(plan, ensure_ascii=False), "organizing", None
    job.retry_attempts, job.next_retry_at = 0, None
    # 外部写入前保存意图；远程响应丢失时队列会从 qB 文件列表继续确认。
    await session.commit()
    try:
        async with qb_client(config) as client:
            await advance_rename(session, client, job, source_id)
            if job.state != "done":
                await advance_rename(session, client, job, source_id, send_request=False)
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code in {400, 409}:
            plan.pop("episode_rename")
            job.plan, job.state = json.dumps(plan, ensure_ascii=False), "done"
            await session.commit()
            raise HTTPException(409, "qBittorrent 拒绝改名，请检查文件名及同名冲突") from exc
        # 请求可能已经被 qB 执行；保留意图，由后台重新查询确认。
    except (httpx.RequestError, HTTPException):
        pass
    return job, pending


async def advance_rename(session, client, job, source_id, *, send_request=True):
    plan = json.loads(job.plan)
    pending = plan["episode_rename"]
    source = await session.get(FeedSource, source_id)
    root = Path(await get_library_root(session))
    directory = (
        Path(source.artwork.directory) if source.artwork else (root / safe_folder_name(source.name))
    )
    if not begin_mutation(source_id):
        finish_mutation(source_id)
        return
    try:
        # 文件 index 稳定；禁止把已被外部移动或替换的文件当作原视频。
        torrent = (
            await request(client, "GET", "torrents/info", params={"hashes": job.info_hash})
        ).json()
        if (
            len(torrent) != 1
            or not torrent[0].get("save_path")
            or str(torrent[0].get("hash", "")).lower() != job.info_hash.lower()
        ):
            raise ValueError("改名任务对应的种子已从 qBittorrent 移除")
        response = await request(client, "GET", "torrents/files", params={"hash": job.info_hash})
        files = response.json()
        file = next((entry for entry in files if entry["index"] == pending["index"]), None)
        name = str(file["name"]).replace("\\", "/") if file else None
        if name not in {pending["old"], pending["new"]}:
            raise ValueError("qBittorrent 文件结构已变化，已暂停改名")
        expected = remote_root(
            str(
                directory.joinpath(
                    *PurePosixPath(
                        pending["relative"] if name == pending["old"] else pending["target"],
                    ).parts
                )
            ),
            await session.get(DownloaderConfig, job.downloader_id),
        )
        location = path_type(torrent[0]["save_path"])(torrent[0]["save_path"])
        if location.joinpath(*PurePosixPath(name).parts) != path_type(expected)(expected):
            raise ValueError("qBittorrent 保存路径已变化，已暂停改名")
        if torrent[0].get("state") == "moving":
            return
        if name == pending["old"]:
            if not send_request:
                return
            original = await resolve_original(root, directory, pending)
            target = original.with_name(PurePosixPath(pending["new"]).name)
            if await asyncio.to_thread(target.exists) or any(
                str(entry["name"]).casefold() == pending["new"].casefold() for entry in files
            ):
                raise ValueError("改名目标已存在，已暂停改名")
            await request(
                client,
                "POST",
                "torrents/renameFile",
                data={
                    "hash": job.info_hash,
                    "oldPath": pending["old"],
                    "newPath": pending["new"],
                },
            )
            # qB 改名异步执行，下一次查询确认后才更改媒体身份和整理记录。
            return
        try:
            target = await asyncio.to_thread(safe_file, root, directory, pending["target"])
        except MediaError:
            return  # qB 已更新文件列表，但文件系统挂载可能尚未刷新。
        info = await asyncio.to_thread(target.stat)
        if info.st_size != pending["size"] or info.st_mtime_ns != pending["mtime_ns"]:
            raise ValueError("改名后的文件版本不一致，已暂停更新记录")
        version = file_version(pending["target"], info.st_size, info.st_mtime_ns)
        new_id = hashlib.sha256(f"{source_id}\0{version}".encode()).hexdigest()
        # 列表轮询可能已经登记新媒体身份。
        await session.execute(
            insert(MediaFile)
            .values(
                id=new_id,
                source_id=source_id,
                relative_path=pending["target"],
                file_version=version,
                size=info.st_size,
                mtime_ns=str(info.st_mtime_ns),
            )
            .on_conflict_do_nothing(index_elements=["id"])
        )
        old_progress = list(
            await session.scalars(
                select(PlaybackProgress).where(
                    PlaybackProgress.media_id == pending["media_id"],
                )
            )
        )
        for row in old_progress:
            values = {
                column.name: getattr(row, column.name)
                for column in PlaybackProgress.__table__.columns
            }
            values["media_id"] = new_id
            statement = insert(PlaybackProgress).values(**values)
            await session.execute(
                statement.on_conflict_do_update(
                    index_elements=["user_id", "media_id"],
                    set_=values,
                    where=PlaybackProgress.updated_at < statement.excluded.updated_at,
                )
            )
        thumbnail = await session.scalar(
            select(EpisodeThumbnail).where(
                EpisodeThumbnail.source_id == source_id,
                EpisodeThumbnail.video_path == pending["relative"],
            )
        )
        if thumbnail:
            existing_thumbnail = await session.scalar(
                select(EpisodeThumbnail.id).where(
                    EpisodeThumbnail.source_id == source_id,
                    EpisodeThumbnail.video_path == pending["target"],
                )
            )
            if existing_thumbnail:
                await session.delete(thumbnail)
            else:
                thumbnail.video_path = pending["target"]
        for entry in plan["files"]:
            if entry["new"] == pending["old"]:
                entry["new"] = pending["new"]
        plan.pop("episode_rename")
        job.plan, job.state = json.dumps(plan, ensure_ascii=False), "done"
        record_event(
            session,
            "download.episode.renamed",
            "feed_source",
            str(source_id),
            {
                "source_id": source_id,
                "old_name": PurePosixPath(pending["old"]).name,
                "filename": PurePosixPath(pending["new"]).name,
            },
        )
        await commit_and_publish(session)
    finally:
        finish_mutation(source_id)


async def resolve_original(root, directory, pending):
    path = await asyncio.to_thread(safe_file, root, directory, pending["relative"])
    info = await asyncio.to_thread(path.stat)
    if info.st_size != pending["size"] or info.st_mtime_ns != pending["mtime_ns"]:
        raise ValueError("原视频已被替换，请刷新列表后重试")
    return path
