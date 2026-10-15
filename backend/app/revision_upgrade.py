"""由 qBittorrent 执行可恢复的修订版替换，旧文件先移到独立备份目录。"""

import asyncio
import json
from pathlib import Path, PurePosixPath

import httpx
from sqlalchemy import select

from .models import DomainEvent, DownloadJob, FeedItem, FeedSource
from .release_versions import release_identity
from .schemas import ParsedRelease
from .staging_cleanup import cleanup_temporary_directories


def paused(torrent):
    return str(torrent.get("state", "")).startswith(("paused", "stopped"))


def healthy(torrent):
    state = str(torrent.get("state", "")).lower()
    return not any(marker in state for marker in ("error", "missing", "check", "moving", "meta"))


def complete(torrent, files, required_videos):
    # qBittorrent 的 progress 是通过 BT 分块校验的数据；同时检查所选文件。
    selected = [f for f in files if f.get("priority", 1) > 0]
    completed_names = {f["name"] for f in selected if f.get("progress", 0) >= 1}
    return (healthy(torrent) and torrent.get("progress", 0) >= 1
            and torrent.get("amount_left", -1) == 0 and bool(selected)
            and required_videos.issubset(completed_names)
            and all(f.get("progress", 0) >= 1 for f in selected))


async def torrent_info(client, info_hash):
    from .download_queue import request

    response = await request(client, "GET", "torrents/info", params={"hashes": info_hash})
    torrents = response.json()
    return torrents[0] if torrents else None


def destination(job, plan):
    from .download_queue import path_type

    result = path_type(job.target_root)(job.target_root) / job.title
    return result if plan["wrapper"] else result / plan["season_folder"]


def video_paths(plan):
    from .download_queue import VIDEO_EXTENSIONS

    return {f["new"] for f in plan["files"]
            if PurePosixPath(f["new"]).suffix.lower() in VIDEO_EXTENSIONS}


async def save(session, job, plan, phase):
    plan["replacement"]["phase"] = phase
    job.plan = json.dumps(plan, ensure_ascii=False)
    job.state = "upgrading"
    await session.commit()


async def begin_upgrade(session, client, job, item, config, torrent, files, conflicts, target):
    from .download_queue import VIDEO_EXTENSIONS, path_type, request, set_running

    if len(conflicts) != 1:
        source = await session.get(FeedSource, item.source_id)
        key = release_identity(item, source)
        current = ParsedRelease.model_validate_json(item.parse_data)
        if key is None:
            return False
        for conflict in conflicts:
            previous = await session.get(FeedItem, conflict.item_id)
            parsed = ParsedRelease.model_validate_json(previous.parse_data)
            if (conflict.downloader_id != job.downloader_id
                    or release_identity(previous, source, parsed) != key
                    or parsed.revision >= current.revision):
                return False
        return any(c.state in {"moving", "upgrading", "replacing", "season_changing"}
                   for c in conflicts)
    old = conflicts[0]
    if (old.downloader_id != job.downloader_id
            or old.info_hash == job.info_hash):
        return False
    previous = await session.get(FeedItem, old.item_id)
    source = await session.get(FeedSource, item.source_id)
    if previous.source_id != item.source_id or previous.parse_status != "parsed":
        return False
    new_release = ParsedRelease.model_validate_json(item.parse_data)
    old_release = ParsedRelease.model_validate_json(previous.parse_data)
    key = release_identity(item, source, new_release)
    if (key is None or key != release_identity(previous, source, old_release)
            or new_release.revision <= old_release.revision):
        return False
    if old.state in {"moving", "upgrading", "replacing", "season_changing"}:
        return True  # 等待前一个整理/替换事务结束，再读取其最终位置。
    if old.state != "done":
        return False
    plan, old_plan = json.loads(job.plan), json.loads(old.plan)
    if len(video_paths(plan)) != 1 or len(video_paths(old_plan)) != 1:
        return False
    old_torrent = await torrent_info(client, old.info_hash)
    old_destination = destination(old, old_plan)
    if (not old_torrent or not healthy(old_torrent)
            or path_type(old.target_root)(old_torrent["save_path"]) != old_destination
            or old_torrent.get("auto_tmm", False)):
        return False
    old_files = (await request(client, "GET", "torrents/files",
                               params={"hash": old.info_hash})).json()
    selected_videos = {f["name"] for f in old_files if f.get("priority", 1) > 0
                       and PurePosixPath(f["name"]).suffix.lower() in VIDEO_EXTENSIONS}
    if selected_videos != video_paths(old_plan):
        return False
    # 旧任务拥有的全部已选文件必须与计划相符，且不能与其他任务共用文件。
    old_names = {f["name"] for f in old_files if f.get("priority", 1) > 0}
    if not old_names.issubset({f["new"] for f in old_plan["files"]}):
        return False
    owned = {str(old_destination / name).casefold() for name in old_names}
    others = await session.scalars(select(DownloadJob).where(
        DownloadJob.id.not_in([job.id, old.id]), DownloadJob.plan.is_not(None),
        DownloadJob.downloader_id == job.downloader_id,
        DownloadJob.state.not_in(["superseded", "ignored"]),
    ))
    for other in others:
        other_plan = json.loads(other.plan)
        if "files" not in other_plan:
            continue
        other_destination = destination(other, other_plan)
        if any(str(other_destination / f["new"]).casefold() in owned
               for f in other_plan["files"]):
            return False
    staging = path_type(job.target_root)(job.target_root) / ".mooncell" / job.info_hash
    if path_type(job.target_root)(torrent["save_path"]) != staging:
        return False
    backup = (path_type(job.target_root)(job.target_root) / ".mooncell" / "replaced"
              / old.info_hash / job.info_hash)
    plan["replacement"] = {
        "old_job_id": old.id, "old_destination": str(old_destination),
        "destination": str(target), "staging": str(staging), "backup": str(backup),
        "old_was_running": not paused(old_torrent), "old_files": sorted(old_names),
    }
    await save(session, job, plan, "downloading")
    await set_running(client, job.info_hash, True)
    return True


def local_path(remote_path, config):
    from .download_queue import path_type

    if config.remote_download_root and config.local_download_root:
        relative = path_type(config.remote_download_root)(remote_path).relative_to(
            path_type(config.remote_download_root)(config.remote_download_root)
        )
        return Path(config.local_download_root).joinpath(*relative.parts)
    return Path(remote_path)


async def advance_upgrade(session, client, job, config, torrent, files):
    from .download_queue import path_type, request, set_running

    plan = json.loads(job.plan)
    upgrade = plan["replacement"]
    phase = upgrade["phase"]
    old = await session.get(DownloadJob, upgrade["old_job_id"])
    if old is None:
        job.state = "needs_review"
        raise ValueError("修订版对应的旧任务记录已丢失，需要审核")
    old_torrent = await torrent_info(client, old.info_hash)
    new_location = path_type(job.target_root)(torrent["save_path"])
    target = path_type(job.target_root)(upgrade["destination"])
    backup = path_type(job.target_root)(upgrade["backup"])
    staging = path_type(job.target_root)(upgrade["staging"])
    original = path_type(old.target_root)(upgrade["old_destination"])
    old_location = path_type(old.target_root)(old_torrent["save_path"]) if old_torrent else None

    if phase == "downloading":
        if new_location != staging or old_location != original:
            job.state = "needs_review"
            raise ValueError("修订版或旧版目录已改变，停止自动替换")
        if not healthy(torrent):
            raise ValueError("新版下载或校验异常，保留旧版")
        if not complete(torrent, files, video_paths(plan)):
            if paused(torrent) and healthy(torrent):
                await set_running(client, job.info_hash, True)
            return
        if not paused(torrent):
            await set_running(client, job.info_hash, False)
            return
        if not healthy(old_torrent):
            return
        if not paused(old_torrent):
            await set_running(client, old.info_hash, False)
            return
        old.state = "replacing"
        await save(session, job, plan, "backup")
        return

    if phase == "backup":
        if not old_torrent:
            job.state = "needs_review"
            raise ValueError("旧版种子已移除，保留新版暂存文件，需要审核")
        if not healthy(old_torrent):
            return
        if not paused(old_torrent):
            await set_running(client, old.info_hash, False)
            return
        if old_location == original:
            await request(client, "POST", "torrents/setLocation", data={
                "hashes": old.info_hash, "location": str(backup),
            })
            return
        if old_location != backup:
            job.state = "needs_review"
            raise ValueError("旧版种子未处于预期备份目录，停止自动替换")
        await save(session, job, plan, "promote")
        return

    if phase == "promote":
        try:
            if old_location != backup or not healthy(old_torrent):
                raise ValueError("旧版备份未确认，无法提升新版")
            if not paused(torrent):
                await set_running(client, job.info_hash, False)
                return
            if not complete(torrent, files, video_paths(plan)):
                raise ValueError("新版文件不完整，恢复旧版")
            expected_names = {f["new"] for f in plan["files"]}
            if (not expected_names.issubset({f["name"] for f in files})
                    or not {f["name"] for f in files if f.get("priority", 1) > 0}
                    .issubset(expected_names)):
                raise ValueError("新版文件结构已改变，恢复旧版")
            if new_location == staging:
                local = local_path(str(target), config)
                if local.is_absolute() and await asyncio.to_thread(lambda: any(
                    local.joinpath(*PurePosixPath(f["new"]).parts).exists()
                    for f in plan["files"]
                )):
                    raise ValueError("替换目标仍有文件占用，恢复旧版")
                await request(client, "POST", "torrents/setLocation", data={
                    "hashes": job.info_hash, "location": str(target),
                })
                return
            if new_location != target:
                raise ValueError("新版目录已改变，停止自动替换")
            await save(session, job, plan, "cleanup")
        except (httpx.HTTPError, ValueError) as exc:
            upgrade["rollback_reason"] = str(exc)
            await save(session, job, plan, "rollback")
        return

    if phase == "rollback":
        # 新版必须先退出媒体库目录，才能把备份恢复到原处。
        if not healthy(torrent):
            return
        if not paused(torrent):
            await set_running(client, job.info_hash, False)
            return
        if new_location == target:
            await request(client, "POST", "torrents/setLocation", data={
                "hashes": job.info_hash, "location": str(staging),
            })
            return
        if new_location != staging or not old_torrent:
            job.state = "needs_review"
            raise ValueError("替换回滚需要审核；旧版备份与新版文件均保留")
        if not healthy(old_torrent):
            return
        if old_location == backup:
            await request(client, "POST", "torrents/setLocation", data={
                "hashes": old.info_hash, "location": str(original),
            })
            return
        if old_location != original:
            job.state = "needs_review"
            raise ValueError("旧版备份目录已改变，需要审核回滚")
        if upgrade["old_was_running"]:
            await set_running(client, old.info_hash, True)
        old.state = "done"
        await cleanup_temporary_directories(client, job.target_root, config)
        upgrade["phase"] = "rolled_back"
        job.plan = json.dumps(plan, ensure_ascii=False)
        job.state = "needs_review"
        raise ValueError(f"修订版替换失败，已恢复旧版：{upgrade['rollback_reason']}")

    if phase == "cleanup":
        if new_location != target or not complete(torrent, files, video_paths(plan)):
            upgrade["rollback_reason"] = "新版入库后完整性检查失败"
            await save(session, job, plan, "rollback")
            return
        if old_torrent:
            if old_location != backup or not healthy(old_torrent):
                job.state = "needs_review"
                raise ValueError("旧版未处于独立备份目录，禁止清理旧文件")
            old_files = (await request(client, "GET", "torrents/files",
                                       params={"hash": old.info_hash})).json()
            if {f["name"] for f in old_files if f.get("priority", 1) > 0} != set(
                upgrade["old_files"]
            ):
                job.state = "needs_review"
                raise ValueError("旧版备份文件结构已改变，禁止清理旧文件")
            # 只删除已确认移入独立备份目录的系统任务，绝不在媒体库原路径删除。
            await request(client, "POST", "torrents/delete", data={
                "hashes": old.info_hash, "deleteFiles": "true",
            })
            return
        old.state = "superseded"
        previous = await session.get(FeedItem, old.item_id)
        previous.parse_status = "superseded"
        await set_running(client, job.info_hash, True)
        await cleanup_temporary_directories(client, job.target_root, config)
        job.state = "done"
        upgrade["phase"] = "done"
        job.plan = json.dumps(plan, ensure_ascii=False)
        session.add(DomainEvent(
            event_type="download.upgraded", resource_type="feed_item",
            resource_id=str(job.item_id), payload=json.dumps({
                "title": job.title, "previous_item_id": old.item_id,
            }, ensure_ascii=False),
        ))
