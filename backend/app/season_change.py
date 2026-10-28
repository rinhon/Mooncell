"""订阅番名与季度变更：保留旧路径快照，统一生成新根目录下的整理计划。"""

import asyncio
import json
import re
from pathlib import PurePosixPath
from uuid import uuid4

from sqlalchemy import select

from .artwork_service import safe_folder_name
from .events import commit_and_publish, record_event
from .models import DownloadJob, FeedItem, FeedSource
from .notifications import update_migration
from .qb_tags import show_tag, sync_show_tag
from .release_parser import parse_release_title
from .schemas import ParsedRelease
from .staging_cleanup import cleanup_temporary_directories

EXCLUDED_STATES = {"ignored", "superseded", "existing"}


class MigrationBlocked(ValueError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


class MigrationWaiting(ValueError):
    """暂时等待，队列继续重试，不产生需要处理提醒。"""


async def schedule_season_change(session, source, season, *, rename_to=None, change_season=True):
    items = list(await session.scalars(select(FeedItem).where(FeedItem.source_id == source.id)))
    jobs = {
        job.item_id: job
        for job in await session.scalars(
            select(DownloadJob).join(FeedItem).where(FeedItem.source_id == source.id)
        )
    }
    changes = []
    for item in items:
        job = jobs.get(item.id)
        parsed = json.loads(item.parse_data)
        target = (
            (season if season is not None else parse_release_title(item.title).season)
            if change_season
            else (job.season if job else parsed.get("season"))
        )
        title = (
            safe_folder_name(rename_to)
            if rename_to is not None
            else (job.title if job else parsed.get("title"))
        )
        plan = json.loads(job.plan) if job and job.plan else {}
        if plan.get("episode_rename"):
            raise ValueError("此订阅有单集正在改名，请等待完成后再修改番名或季度")
        if job and job.state not in EXCLUDED_STATES:
            if "season_change" in plan:
                pending = plan["season_change"]
                if pending["season"] != target or pending.get("title", job.title) != title:
                    raise ValueError("此订阅的媒体库迁移尚未完成，请在下载中心查看进度后再修改")
                changes.append((item, job, plan, target, title))
                continue
            if job.state in {"upgrading", "replacing"} or plan.get("replacement", {}).get(
                "phase", "done"
            ) not in {"done", "rolled_back"}:
                raise ValueError("修订版替换尚未结束，请等待完成后再修改番名或季度")
            if target is None:
                raise ValueError("已有下载无法从标题识别季度，请填写明确的季度")
        changes.append((item, job, plan, target, title))
    scheduled = []
    for item, job, plan, target, title in changes:
        parsed = json.loads(item.parse_data)
        if change_season:
            parsed["season"] = target
        if rename_to is not None:
            parsed["title"] = title
        item.parse_data = json.dumps(parsed, ensure_ascii=False)
        if not job or job.state in EXCLUDED_STATES or (job.season == target and job.title == title):
            continue
        migration = {
            "phase": "prepare",
            "previous_season": job.season,
            "season": target,
            "previous_title": job.title,
            "title": title,
            "previous_state": job.state,
            "previous_plan": plan,
            "token": uuid4().hex,
        }
        job.title, job.season = title, target
        job.plan = json.dumps({**plan, "season_change": migration}, ensure_ascii=False)
        job.state, job.last_error = "season_changing", None
        scheduled.append((job.id, migration["token"]))
    return scheduled


def file_name(file):
    return str(file["name"]).replace("\\", "/")


def absolute_names(location, names):
    from .download_queue import path_type

    return {
        str(path_type(location)(location).joinpath(*PurePosixPath(name).parts)).casefold()
        for name in names
    }


def make_plan(job, item, migration, files):
    from .download_queue import VIDEO_EXTENSIONS, build_plan

    previous = migration["previous_plan"]
    known = {}
    known_names = {}
    for entry in previous.get("files", []):
        episode = parse_release_title(PurePosixPath(entry["new"]).stem).episode_start
        for name in (entry["old"], entry["new"]):
            known[name] = episode
            known_names[name] = entry["new"]
            if previous.get("wrapper"):
                original = str(PurePosixPath(previous["wrapper"], *PurePosixPath(name).parts[1:]))
                known[original] = episode
                known_names[original] = entry["new"]
    try:
        release = ParsedRelease.model_validate_json(item.parse_data)
    except ValueError:
        release = parse_release_title(item.title)
    overrides = {}
    for index, file in enumerate(files):
        name = file_name(file)
        if PurePosixPath(name).suffix.lower() not in VIDEO_EXTENSIONS:
            continue
        if file.get("priority", 1) == 0 or int(file.get("index", index)) in previous.get(
            "skip_file_ids", []
        ):
            overrides[name] = None
        else:
            episode = known.get(name)
            if episode is None:
                episode = parse_release_title(PurePosixPath(name).stem).episode_start
            if episode is not None and previous.get("files"):
                overrides[name] = episode
    plan = build_plan(files, job.title, job.season, release, overrides)
    previous_names = {}
    for file in files:
        name = file_name(file)
        normalized = (
            str(PurePosixPath(plan["season_folder"], *PurePosixPath(name).parts[1:]))
            if plan["wrapper"]
            else name
        )
        previous_names[normalized] = known_names.get(name)
    # 字幕等伴随文件已有 SxxExx 标记时，只修改季度，保留集数及语言后缀。
    for entry in plan["files"]:
        path = PurePosixPath(entry["new"])
        previous_name = previous_names.get(entry["old"])
        if previous_name and re.search(r"(?i)S\d{1,2}E\d", PurePosixPath(previous_name).name):
            path = path.with_name(PurePosixPath(previous_name).name)
        filename = re.sub(r"(?i)(?<![a-z0-9])S\d{1,2}(?=E\d)", f"S{job.season:02d}", path.name)
        previous_title = migration.get("previous_title", job.title)
        if previous_title != job.title:
            marker = re.search(r"(?i)(?<![a-z0-9])S\d{1,2}(?P<episode>E\d.*)$", filename)
            if marker:
                filename = f"{job.title} S{job.season:02d}{marker['episode']}"
        entry["new"] = str(path.with_name(filename))
    target_by_old = {entry["old"]: entry["new"] for entry in plan["files"]}
    entries = []
    for index, file in enumerate(files):
        old = file_name(file)
        normalized = (
            str(PurePosixPath(plan["season_folder"], *PurePosixPath(old).parts[1:]))
            if plan["wrapper"]
            else old
        )
        entries.append(
            {
                "index": int(file.get("index", index)),
                "old": old,
                "new": target_by_old.get(normalized, normalized),
            }
        )
    if len({entry["new"].casefold() for entry in entries}) != len(entries):
        raise MigrationBlocked(
            "path_conflict",
            "媒体库迁移后的文件名冲突，停止操作",
        )
    plan["show_tag"] = show_tag(job.title)
    return plan, entries


async def check_conflicts(session, client, job, config, migration, *, source=False):
    from .download_queue import path_type, request
    from .revision_upgrade import destination, local_path

    target = migration["destination"]
    names = [entry["new"] for entry in migration["entries"]]
    targets = absolute_names(target, names)
    original = absolute_names(
        migration["original_location"], [entry["old"] for entry in migration["entries"]]
    )
    # 同时检查尚未开始迁移的数据库任务与 qB 中不由 Mooncell 管理的任务。
    others = await session.scalars(
        select(DownloadJob).where(
            DownloadJob.id != job.id,
            DownloadJob.plan.is_not(None),
            DownloadJob.state.not_in(["ignored", "superseded", "existing"]),
        )
    )
    for other in others:
        plan = json.loads(other.plan)
        pending = plan.get("season_change", {})
        if pending.get("target_plan"):
            plan = pending["target_plan"]
        if not plan.get("files") or "season_folder" not in plan:
            continue
        occupied = absolute_names(
            str(destination(other, plan)), [entry["new"] for entry in plan["files"]]
        )
        if targets & occupied:
            raise MigrationBlocked(
                "path_conflict",
                "媒体库迁移目标已有其他下载任务，保留原文件，请先解决冲突",
            )
    torrents = (await request(client, "GET", "torrents/info")).json()
    paths_to_check = targets | original if source else targets
    for torrent in torrents:
        if torrent["hash"].lower() == job.info_hash.lower():
            continue
        location = str(torrent["save_path"])
        root = str(path_type(location)(location)).casefold()
        separator = "\\" if path_type(location).__name__ == "PureWindowsPath" else "/"
        if not any(path.startswith(root.rstrip("/\\") + separator) for path in paths_to_check):
            continue
        files = (
            await request(client, "GET", "torrents/files", params={"hash": torrent["hash"]})
        ).json()
        occupied = absolute_names(location, [file_name(file) for file in files])
        if source and original & occupied:
            raise MigrationBlocked(
                "path_conflict",
                "原文件与其他 qB 任务共享，停止媒体库迁移，避免影响其他任务",
            )
        if targets & occupied:
            raise MigrationBlocked(
                "path_conflict",
                "媒体库迁移目标与 qB 中的其他任务冲突，不会覆盖文件",
            )
    local = local_path(target, config)
    if local.is_absolute():
        candidates = [local.joinpath(*PurePosixPath(name).parts) for name in names]
        if await asyncio.to_thread(
            lambda: any(
                path.exists() and (not source or str(path).casefold() not in original)
                for path in candidates
            )
        ):
            raise MigrationBlocked(
                "path_conflict",
                "媒体库迁移目标已有同名文件，不会覆盖，请先解决冲突",
            )


async def save_phase(session, job, migration, phase):
    migration["phase"] = phase
    plan = json.loads(job.plan)
    plan["season_change"] = migration
    job.plan = json.dumps(plan, ensure_ascii=False)
    await commit_and_publish(session)


async def advance_season_change(session, client, job, config, item, torrent):
    from .download_queue import path_type, request, set_running
    from .playback.leases import begin_mutation, finish_mutation
    from .revision_upgrade import destination, healthy, paused

    if not begin_mutation(item.source_id):
        raise MigrationWaiting("正在播放此作品，释放播放文件后自动继续迁移")

    migration = json.loads(job.plan)["season_change"]
    phase = migration["phase"]
    if torrent is None:
        if phase != "prepare" or migration["previous_state"] != "queued":
            raise MigrationBlocked(
                "torrent_removed",
                "媒体库迁移任务已从 qB 移除，保留记录，不会重新下载",
            )
        staging = path_type(job.target_root)(job.target_root) / ".mooncell" / job.info_hash
        response = await request(
            client,
            "POST",
            "torrents/add",
            data={
                "urls": item.download_url,
                "savepath": str(staging),
                "autoTMM": "false",
                "contentLayout": "Original",
                "paused": "false",
                "stopped": "false",
                "stopCondition": "MetadataReceived",
                "tags": show_tag(job.title),
            },
        )
        if not response.text.strip().startswith("Ok"):
            raise MigrationWaiting("qBittorrent 未接受下载任务，等待重试")
        return
    if not healthy(torrent):
        if any(marker in str(torrent.get("state", "")).lower() for marker in ("error", "missing")):
            raise MigrationBlocked(
                "torrent_unhealthy",
                "qB 任务或文件异常，保留原文件，请检查下载器后继续迁移",
            )
        return
    if torrent.get("auto_tmm", False):
        raise MigrationBlocked(
            "auto_management",
            "请先关闭此种子的自动种子管理，再继续媒体库迁移",
        )
    location = path_type(job.target_root)(torrent["save_path"])
    files = (await request(client, "GET", "torrents/files", params={"hash": job.info_hash})).json()
    if not files:
        raise MigrationWaiting("等待下载器提供文件列表")
    if phase == "prepare":
        previous = migration["previous_plan"]
        staging = path_type(job.target_root)(job.target_root) / ".mooncell" / job.info_hash
        expected = {staging}
        if "season_folder" in previous:
            previous_root = path_type(job.target_root)(job.target_root) / migration.get(
                "previous_title", job.title
            )
            expected.add(
                previous_root
                if previous.get("wrapper")
                else previous_root / previous["season_folder"]
            )
        if location not in expected:
            raise MigrationBlocked(
                "path_changed",
                "qB 保存路径已被手动修改，停止媒体库迁移，请核对原目录",
            )
        plan, entries = make_plan(job, item, migration, files)
        if migration["previous_state"] == "done" and {
            file_name(file) for file in files if file.get("priority", 1) > 0
        } != {entry["new"] for entry in previous.get("files", [])}:
            raise MigrationBlocked(
                "files_changed",
                "已入库任务的文件列表已被修改，停止媒体库迁移，请核对原文件",
            )
        source = await session.get(FeedSource, item.source_id)
        migration.update(
            {
                "original_location": str(location),
                "was_running": not paused(torrent)
                or bool(source and source.active)
                and migration["previous_state"]
                in {
                    "queued",
                    "metadata",
                    "organizing",
                    "moving",
                },
                "target_plan": plan,
                "entries": entries,
                "destination": str(destination(job, plan)),
                "staging": str(
                    path_type(job.target_root)(job.target_root)
                    / ".mooncell"
                    / "season-change"
                    / job.info_hash
                    / migration["token"]
                ),
            }
        )
        await check_conflicts(session, client, job, config, migration, source=True)
        await save_phase(session, job, migration, "pause")
        return
    original = path_type(job.target_root)(migration["original_location"])
    staging = path_type(job.target_root)(migration["staging"])
    target = path_type(job.target_root)(migration["destination"])
    expected = {
        "pause": {original},
        "stage": {original, staging},
        "rename": {staging},
        "move": {staging, target},
        "name": {target},
        "tags": {target},
        "restore": {target},
    }
    if location not in expected.get(phase, set()):
        raise MigrationBlocked(
            "path_changed",
            "媒体库迁移期间保存路径发生变化，已停止操作，请核对下载器",
        )
    by_id = {int(file.get("index", index)): file_name(file) for index, file in enumerate(files)}
    if set(by_id) != {entry["index"] for entry in migration["entries"]} or any(
        by_id[entry["index"]] not in {entry["old"], entry["new"]} for entry in migration["entries"]
    ):
        raise MigrationBlocked(
            "files_changed",
            "媒体库迁移期间文件结构发生变化，已停止操作",
        )
    required_name = "old" if phase in {"pause", "stage"} else "new"
    if phase != "rename" and any(
        by_id[entry["index"]] != entry[required_name] for entry in migration["entries"]
    ):
        raise MigrationBlocked(
            "files_changed",
            "媒体库迁移文件名与当前阶段不符，已停止操作，请核对下载器",
        )
    if phase != "restore" and not paused(torrent):
        await set_running(client, job.info_hash, False)
        return
    if phase == "pause":
        await check_conflicts(session, client, job, config, migration, source=True)
        await save_phase(session, job, migration, "stage")
    elif phase == "stage":
        if location == original:
            await check_conflicts(session, client, job, config, migration, source=True)
            await request(
                client,
                "POST",
                "torrents/setLocation",
                data={
                    "hashes": job.info_hash,
                    "location": str(staging),
                },
            )
        else:
            await save_phase(session, job, migration, "rename")
    elif phase == "rename":
        for entry in migration["entries"]:
            current = by_id[entry["index"]]
            if current != entry["new"]:
                await request(
                    client,
                    "POST",
                    "torrents/renameFile",
                    data={
                        "hash": job.info_hash,
                        "oldPath": current,
                        "newPath": entry["new"],
                    },
                )
                return
        await save_phase(session, job, migration, "move")
    elif phase == "move":
        if location == staging:
            await check_conflicts(session, client, job, config, migration)
            await request(
                client,
                "POST",
                "torrents/setLocation",
                data={
                    "hashes": job.info_hash,
                    "location": str(target),
                },
            )
        else:
            await save_phase(session, job, migration, "tags")
    elif phase in {"name", "tags"}:  # 兼容旧版本已持久化的任务改名阶段。
        if await sync_show_tag(
            client, job.info_hash, torrent, job.title, migration["previous_plan"].get("show_tag")
        ):
            migration["target_plan"]["show_tag"] = show_tag(job.title)
            await save_phase(session, job, migration, "restore")
    elif phase == "restore":
        # 旧版本可能已经进入恢复阶段，也应补标签并保留当前任务名。
        if not migration["target_plan"].get("show_tag"):
            if not await sync_show_tag(
                client,
                job.info_hash,
                torrent,
                job.title,
                migration["previous_plan"].get("show_tag"),
            ):
                return
            migration["target_plan"]["show_tag"] = show_tag(job.title)
            await save_phase(session, job, migration, "restore")
            return
        if paused(torrent) == migration["was_running"]:
            await set_running(client, job.info_hash, migration["was_running"])
            return
        await cleanup_temporary_directories(client, job.target_root, config)
        job.plan = json.dumps(migration["target_plan"], ensure_ascii=False)
        job.state, job.last_error = "done", None
        finish_mutation(item.source_id)
        operation_id = await update_migration(
            session,
            job,
            "completed",
            token=migration["token"],
        )
        record_event(
            session,
            "download.library.changed",
            "feed_item",
            str(item.id),
            {
                "title": job.title,
                "previous_season": migration["previous_season"],
                "previous_title": migration.get("previous_title", job.title),
                "season": job.season,
                "source_id": item.source_id,
                "operation_id": operation_id,
            },
        )
