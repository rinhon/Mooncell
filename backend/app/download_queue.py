"""订阅下载队列：通过 qBittorrent 管理真实文件路径，保持做种有效。"""

import asyncio
import json
import logging
import re
from pathlib import Path, PurePosixPath, PureWindowsPath

import httpx
from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert

from .artwork_service import safe_folder_name
from .database import SessionFactory
from .downloader_service import extract_info_hash
from .library import get_library_root
from .models import DomainEvent, DownloaderConfig, DownloadJob, FeedItem, FeedSource
from .release_parser import parse_release_title
from .release_versions import release_identity, select_revisions
from .schemas import ParsedRelease
from .security import decrypt_secret

logger = logging.getLogger(__name__)
VIDEO_EXTENSIONS = {".mkv", ".mp4", ".ts", ".m2ts", ".avi", ".mov", ".webm"}
SUBTITLE_EXTENSIONS = {".ass", ".ssa", ".srt", ".vtt", ".sup", ".sub", ".idx"}
LANGUAGE_MARKER = re.compile(
    r"(?<![a-z0-9])(?P<hans>chs|sc|gb|zh[-_]hans|zh[-_]cn)(?![a-z0-9])"
    r"|(?<![a-z0-9])(?P<hant>cht|tc|big5|zh[-_]hant|zh[-_]tw)(?![a-z0-9])"
    r"|(?P<cn>简体|簡體|简中|簡中|简日|簡日)"
    r"|(?P<tw>繁体|繁體|繁中|繁日)|(?P<dual>(?:简繁|簡繁)(?:内封|內封)?)",
    re.IGNORECASE,
)
queue_lock = asyncio.Lock()


def path_type(path):
    return PureWindowsPath if PureWindowsPath(path).drive else PurePosixPath


def remote_root(root, config):
    """只在已配置的本地根目录范围内转换下载器路径。"""
    if config.local_download_root and config.remote_download_root:
        local = path_type(config.local_download_root)
        try:
            relative = local(root).relative_to(local(config.local_download_root))
        except ValueError as exc:
            raise ValueError("媒体库不在下载器本地路径映射范围内") from exc
        return str(path_type(config.remote_download_root)(config.remote_download_root)
                   .joinpath(*relative.parts))
    return root


async def enqueue_source(session, source):
    if not source.active:
        return
    config = await session.scalar(select(DownloaderConfig).where(
        DownloaderConfig.active.is_(True), DownloaderConfig.kind == "qbittorrent",
        DownloaderConfig.organize_strategy == "downloader_managed",
    ).order_by(DownloaderConfig.id))
    if config is None:
        return
    root = remote_root(await get_library_root(session, config.library_root), config)
    title = safe_folder_name(source.name)
    items = list(await session.scalars(select(FeedItem).where(
        FeedItem.source_id == source.id, FeedItem.parse_status == "parsed",
        FeedItem.download_url.is_not(None),
    )))
    previous_jobs = list((await session.execute(
        select(DownloadJob, FeedItem).join(FeedItem).where(
            FeedItem.source_id == source.id, DownloadJob.downloader_id == config.id,
            DownloadJob.target_root == root,
            DownloadJob.state.not_in(["ignored", "superseded", "existing"]),
        )
    )).all())
    for item in await select_revisions(session, source, items):
        info_hash = item.info_hash or extract_info_hash(item.download_url)
        if not info_hash:
            continue
        parsed = ParsedRelease.model_validate_json(item.parse_data)
        manual = "manual_review" in parsed.evidence
        season = parsed.season if manual else (
            source.season if source.season is not None else parsed.season
        )
        if season is None or parsed.episode_start is None:
            continue
        library_title = safe_folder_name(parsed.title) if manual else title
        key = release_identity(item, source, parsed)
        predecessors = [
            (old, ParsedRelease.model_validate_json(previous.parse_data).revision)
            for old, previous in previous_jobs
            if key is not None and key == release_identity(previous, source)
            and ParsedRelease.model_validate_json(previous.parse_data).revision < parsed.revision
        ]
        if predecessors and not manual:
            # 沿用旧版实际媒体库名称，保留此前的人工修正。
            library_title = max(predecessors, key=lambda pair: pair[1])[0].title
        await session.execute(insert(DownloadJob).values(
            item_id=item.id, info_hash=info_hash, downloader_id=config.id,
            target_root=root, title=library_title,
            season=season, state="queued",
        ).on_conflict_do_nothing())


def subtitle_language(path):
    """优先使用文件名的明确标记，其次使用最近一层目录，不猜测未标记资源。"""
    for part in reversed(path.parts):
        languages = set()
        for match in LANGUAGE_MARKER.finditer(part):
            if match.lastgroup in {"hans", "cn", "dual"}:
                languages.add("hans")
            if match.lastgroup in {"hant", "tw", "dual"}:
                languages.add("hant")
        if languages:
            return languages
    return set()


def language_preference(paths):
    """逐集优先简中独立版，其次简繁内封，最后繁中独立版。"""
    keys = {}
    ranks = {}
    best = {}
    for path in paths:
        kind = ("video" if path.suffix.lower() in VIDEO_EXTENSIONS else
                "subtitle" if path.suffix.lower() in SUBTITLE_EXTENSIONS else None)
        if kind is None:
            continue
        parsed = parse_release_title(path.stem)
        # 没有明确集数时仅匹配去掉语言标记后同名的文件，不跨文件猜集数。
        if parsed.episode_start is not None:
            identity = (parsed.episode_start, parsed.episode_end)
        else:
            identity = re.sub(r"[\W_]+", "", LANGUAGE_MARKER.sub("", path.stem)).casefold()
        keys[path] = (kind, parsed.media_type, parsed.season, identity)
        languages = subtitle_language(path)
        if not languages:
            continue
        ranks[path] = 0 if languages == {"hans"} else 1 if "hans" in languages else 2
        best[keys[path]] = min(best.get(keys[path], 2), ranks[path])
    return {path for path, key in keys.items()
            if path in ranks and ranks[path] > best[key]}


def build_plan(files, title, season, release, overrides=None):
    paths = [PurePosixPath(str(f["name"]).replace("\\", "/")) for f in files]
    if any(p.is_absolute() or ".." in p.parts or not p.parts for p in paths):
        raise ValueError("种子包含无效文件路径")
    roots = {p.parts[0] for p in paths}
    wrapper = (
        next(iter(roots)) if len(roots) == 1 and all(len(p.parts) > 1 for p in paths) else None
    )
    season_folder = f"Season {season:02d}"
    skipped = language_preference(paths)
    overrides = overrides or {}
    if set(overrides) - {str(p) for p in paths}:
        raise ValueError("下载器文件列表已变化，请重新加载文件")
    skipped.update(p for p in paths if str(p) in overrides and overrides[str(p)] is None)
    # 用户显式选择的版本优先于自动语言筛选。
    skipped.difference_update(p for p in paths if overrides.get(str(p)) is not None)
    videos = [p for p in paths if p.suffix.lower() in VIDEO_EXTENSIONS and p not in skipped]
    if not videos:
        raise ValueError("种子中没有可整理的视频")
    renames = []
    targets = set()
    for p in paths:
        if p in skipped:
            continue
        old = str(PurePosixPath(season_folder, *p.parts[1:])) if wrapper else str(p)
        target = old
        if p in videos:
            parsed = parse_release_title(p.stem)
            episode = parsed.episode_start
            manual = str(p) in overrides or (
                len(videos) == 1 and "manual_review" in release.evidence
                and release.release_kind == "single"
            )
            if manual:
                episode = overrides.get(str(p), release.episode_start)
            if len(videos) == 1 and episode is None:
                episode = release.episode_start
            if episode is None or (not manual and parsed.release_kind != "single"):
                raise ValueError(f"无法确定视频集数：{p.name}")
            if not manual and parsed.media_type != "episode":
                raise ValueError(f"特殊视频需要审核：{p.name}")
            episode_text = f"{episode:g}".zfill(2)
            filename = f"{title} S{season:02d}E{episode_text}{p.suffix}"
            target = str(PurePosixPath(season_folder, filename)) if wrapper else filename
        if target.casefold() in targets:
            raise ValueError(f"重命名后文件冲突：{target}")
        targets.add(target.casefold())
        renames.append({"old": old, "new": target})
    return {
        "wrapper": wrapper, "season_folder": season_folder, "files": renames,
        "skip_file_ids": [int(f.get("index", index)) for index, (f, p)
                          in enumerate(zip(files, paths, strict=True)) if p in skipped],
        "selection_version": 2,
    }


async def request(client, method, endpoint, **kwargs):
    response = await client.request(method, f"/api/v2/{endpoint}", **kwargs)
    response.raise_for_status()
    return response


async def set_running(client, info_hash, running):
    """兼容 qBittorrent 5 的 start/stop 和 4 的 resume/pause。"""
    try:
        await request(client, "POST", "torrents/start" if running else "torrents/stop",
                      data={"hashes": info_hash})
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code != 404:
            raise
        await request(client, "POST", "torrents/resume" if running else "torrents/pause",
                      data={"hashes": info_hash})


async def process_job(session, job, config, item):
    async with httpx.AsyncClient(base_url=config.base_url, timeout=10,
                                 verify=config.verify_tls) as client:
        login = await request(client, "POST", "auth/login", data={
            "username": config.username or "",
            "password": decrypt_secret(config.encrypted_secret) or "",
        })
        if login.status_code != 204 and not login.text.startswith("Ok"):
            raise ValueError("qBittorrent 拒绝登录，请检查凭据")
        response = await request(client, "GET", "torrents/info", params={"hashes": job.info_hash})
        torrents = response.json()
        if not torrents:
            if job.state != "queued":
                raise ValueError("下载任务已从下载器移除，不会自动重新添加")
            # 每个种子独立暂存，避免未重命名的资源互相覆盖。
            staging = str(path_type(job.target_root)(job.target_root) / ".mooncell" / job.info_hash)
            added = await request(client, "POST", "torrents/add", data={
                "urls": item.download_url, "savepath": staging, "autoTMM": "false",
                "contentLayout": "Original", "paused": "false", "stopped": "false",
                "stopCondition": "MetadataReceived",
            })
            if not added.text.strip().startswith("Ok"):
                raise ValueError("qBittorrent 未接受下载任务")
            job.state = "metadata"
            await session.commit()
            return
        torrent = torrents[0]
        if torrent.get("state") == "moving":
            return
        # 不接管用户在其他目录手工添加的同 hash 任务。
        staging = path_type(job.target_root)(job.target_root) / ".mooncell" / job.info_hash
        if job.state == "queued":
            if path_type(str(torrent["save_path"]))(torrent["save_path"]) != staging:
                job.state = "existing"
                return
            job.state = "metadata"
        if "meta" in str(torrent.get("state", "")).lower():
            return
        response = await request(client, "GET", "torrents/files", params={"hash": job.info_hash})
        files = response.json()
        if not files:
            return
        if job.plan and json.loads(job.plan).get("replacement"):
            from .revision_upgrade import advance_upgrade

            await advance_upgrade(session, client, job, config, torrent, files)
            return
        if (not job.plan or json.loads(job.plan).get("selection_version")) and not str(
            torrent.get("state", "")
        ).startswith(("paused", "stopped")):
            await set_running(client, job.info_hash, False)
            return  # 确认暂停后才筛选、重命名，失败时不继续下载全部版本。
        if not job.plan:
            try:
                plan = build_plan(files, job.title, job.season,
                                  ParsedRelease.model_validate_json(item.parse_data))
            except ValueError:
                job.state = "needs_review"
                raise
            job.plan = json.dumps(plan, ensure_ascii=False)
            job.state = "organizing"
            await session.commit()
        plan = json.loads(job.plan)
        skipped_ids = set(plan.get("skip_file_ids", []))
        selected_ids = [int(f.get("index", index)) for index, f in enumerate(files)
                        if int(f.get("index", index)) not in skipped_ids
                        and PurePosixPath(f["name"]).suffix.lower() in VIDEO_EXTENSIONS
                        and f.get("priority", 1) == 0]
        if selected_ids:
            await request(client, "POST", "torrents/filePrio", data={
                "hash": job.info_hash, "id": "|".join(map(str, selected_ids)), "priority": 1,
            })
            return
        pending_skip = [int(f.get("index", index)) for index, f in enumerate(files)
                        if int(f.get("index", index)) in skipped_ids and f.get("priority") != 0]
        if pending_skip:
            await request(client, "POST", "torrents/filePrio", data={
                "hash": job.info_hash, "id": "|".join(map(str, pending_skip)), "priority": 0,
            })
            return  # 下一轮确认 priority=0 后才能继续，使用原始文件 index 防止改名后失配。
        names = {str(f["name"]).replace("\\", "/") for f in files}
        wrapper = plan["wrapper"]
        if wrapper and wrapper != plan["season_folder"] and any(
            name.startswith(wrapper + "/") for name in names
        ):
            await request(client, "POST", "torrents/renameFolder", data={
                "hash": job.info_hash, "oldPath": wrapper, "newPath": plan["season_folder"],
            })
            return  # 下一轮从下载器重新读取，确认异步重命名已生效。
        for file in plan["files"]:
            if file["new"] in names:
                continue
            if file["old"] not in names:
                raise ValueError("下载器文件结构已变化，无法继续重命名")
            await request(client, "POST", "torrents/renameFile", data={
                "hash": job.info_hash, "oldPath": file["old"], "newPath": file["new"],
            })
            return
        destination = path_type(job.target_root)(job.target_root) / job.title
        if not wrapper:
            destination /= plan["season_folder"]
        # 不同种子即使发布名不同，也不能写入同一最终视频路径。
        other_jobs = list(await session.scalars(select(DownloadJob).where(
            DownloadJob.id != job.id, DownloadJob.target_root == job.target_root,
            DownloadJob.season == job.season,
            DownloadJob.plan.is_not(None),
            DownloadJob.state.in_(["moving", "done", "upgrading", "replacing"]),
        )))
        video_names = {PurePosixPath(f["new"]).name.casefold() for f in plan["files"]
                       if PurePosixPath(f["new"]).suffix.lower() in VIDEO_EXTENSIONS}
        source = await session.get(FeedSource, item.source_id)
        key = release_identity(item, source)
        conflicts = []
        for other in other_jobs:
            other_item = await session.get(FeedItem, other.item_id)
            same_release = key is not None and key == release_identity(other_item, source)
            if same_release or (other.title.casefold() == job.title.casefold() and any(
                PurePosixPath(f["new"]).name.casefold() in video_names
                for f in json.loads(other.plan)["files"]
            )):
                conflicts.append(other)
        if conflicts:
            from .revision_upgrade import begin_upgrade

            if await begin_upgrade(session, client, job, item, config, torrent,
                                   files, conflicts, destination):
                return
            job.state = "needs_review"
            raise ValueError("媒体库已有同集下载任务，需要审核版本冲突")
        if path_type(str(torrent["save_path"]))(torrent["save_path"]) != destination:
            if job.state != "moving":
                local_destination = str(destination)
                if config.remote_download_root and config.local_download_root:
                    remote = path_type(config.remote_download_root)
                    relative = remote(destination).relative_to(remote(config.remote_download_root))
                    local_destination = str(
                        Path(config.local_download_root).joinpath(*relative.parts)
                    )
                local = Path(local_destination)
                # 仅检查当前服务能访问的绝对目录；远程目录还需要下载器端的冲突响应。
                if local.is_absolute():
                    targets = [local.joinpath(*PurePosixPath(f["new"]).parts)
                               for f in plan["files"]]
                    if await asyncio.to_thread(lambda: any(p.exists() for p in targets)):
                        job.state = "needs_review"
                        raise ValueError("目标目录已有同名文件，已停止自动整理")
            job.state = "moving"
            await session.commit()
            await request(client, "POST", "torrents/setLocation", data={
                "hashes": job.info_hash, "location": str(destination),
            })
            return
        if torrent.get("state") == "moving":
            return
        if plan.get("selection_version"):
            await set_running(client, job.info_hash, True)
        job.state = "done"


async def process_queue():
    async with queue_lock:
        async with SessionFactory() as session:
            ids = list(await session.scalars(select(DownloadJob.id).where(
                DownloadJob.state.in_(["queued", "metadata", "organizing", "moving",
                                       "upgrading"]),
            ).order_by(DownloadJob.id)))
        for job_id in ids:
            async with SessionFactory() as session:
                job = await session.get(DownloadJob, job_id)
                config = await session.get(DownloaderConfig, job.downloader_id)
                item = await session.get(FeedItem, job.item_id)
                source = await session.get(FeedSource, item.source_id) if item else None
                if not config or not config.active or not source or not source.active:
                    continue
                await session.commit()
                try:
                    await process_job(session, job, config, item)
                    job.last_error = None
                except Exception as exc:
                    from .events import _redact
                    error = _redact(f"{type(exc).__name__}: {exc}")[:1000]
                    if error != job.last_error:
                        session.add(DomainEvent(
                            event_type="download.failed", resource_type="feed_item",
                            resource_id=str(item.id),
                            payload=json.dumps({"error": error}, ensure_ascii=False),
                        ))
                    job.last_error = error
                await session.commit()


async def download_queue_loop():
    while True:
        try:
            await process_queue()
        except Exception:
            logger.exception("下载队列处理失败")
        await asyncio.sleep(5)
