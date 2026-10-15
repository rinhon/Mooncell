"""真实发布与整理审核：决定持久化，继续保留队列的路径冲突检查。"""

import json
from pathlib import PurePosixPath

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .api import _record_and_publish_event
from .artwork_service import safe_folder_name
from .database import get_session
from .dependencies import require_user
from .download_queue import (
    VIDEO_EXTENSIONS,
    build_plan,
    enqueue_source,
    path_type,
    queue_lock,
    request,
    set_running,
)
from .events import _redact
from .library import get_library_root
from .models import DownloaderConfig, DownloadJob, FeedItem, FeedSource
from .release_parser import parse_release_title
from .schemas import ApiMessage, ParsedRelease
from .security import decrypt_secret

router = APIRouter(prefix="/api/v1/review", dependencies=[Depends(require_user)])


class ReviewRead(BaseModel):
    id: int
    raw_title: str
    source_name: str
    source_active: bool
    parsed: ParsedRelease
    season: int | None
    reason: str
    proposed_path: str | None
    job_state: str | None


class FileCorrection(BaseModel):
    name: str = Field(min_length=1, max_length=4096)
    episode: float | None = Field(default=None, ge=0, le=99999, allow_inf_nan=False)


class ReviewApproval(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    season: int = Field(ge=0, le=99)
    episode: float = Field(ge=0, le=99999, allow_inf_nan=False)
    files: list[FileCorrection] | None = Field(default=None, max_length=2000)


def pending(item, job):
    return item.parse_status == "needs_review" or (
        item.parse_status != "ignored" and job is not None and job.state == "needs_review"
    )


def require_replacement_settled(job):
    if job and job.plan:
        if "season_change" in json.loads(job.plan):
            raise HTTPException(409, "媒体库迁移尚未完成，请先在下载中心检查迁移状态")
        phase = json.loads(job.plan).get("replacement", {}).get("phase")
        if phase in {"backup", "promote", "cleanup", "rollback"}:
            raise HTTPException(409, "旧版替换事务尚未结束，请先恢复下载器中的任务和目录")


async def load_pending(session, item_id):
    item = await session.get(FeedItem, item_id)
    if item is None:
        raise HTTPException(404, "审核条目不存在")
    job = await session.scalar(select(DownloadJob).where(DownloadJob.item_id == item_id))
    if not pending(item, job):
        raise HTTPException(409, "该条目已处理，请刷新审核列表")
    source = await session.get(FeedSource, item.source_id)
    return item, source, job


async def job_files(session, job, stop=False, require_files=True):
    config = await session.get(DownloaderConfig, job.downloader_id)
    if not config or not config.active or config.kind != "qbittorrent":
        raise HTTPException(409, "请先启用此任务对应的 qBittorrent 下载器")
    try:
        async with httpx.AsyncClient(base_url=config.base_url, timeout=10,
                                     verify=config.verify_tls) as client:
            login = await request(client, "POST", "auth/login", data={
                "username": config.username or "",
                "password": decrypt_secret(config.encrypted_secret) or "",
            })
            if login.status_code != 204 and not login.text.startswith("Ok"):
                raise ValueError("qBittorrent 拒绝登录")
            if stop:
                await set_running(client, job.info_hash, False)
            if not require_files:
                return []
            result = await request(client, "GET", "torrents/files",
                                   params={"hash": job.info_hash})
            files = result.json()
            if not files:
                raise ValueError("下载器中没有文件，请确认种子仍存在且元数据已获取")
            return files
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(502, _redact(f"无法读取下载器文件：{exc}")) from exc


@router.get("", response_model=list[ReviewRead])
async def list_reviews(session: AsyncSession = Depends(get_session)):
    rows = await session.execute(
        select(FeedItem, FeedSource, DownloadJob)
        .join(FeedSource, FeedItem.source_id == FeedSource.id)
        .outerjoin(DownloadJob, DownloadJob.item_id == FeedItem.id)
        .where(FeedItem.parse_status != "ignored", or_(
            FeedItem.parse_status == "needs_review", DownloadJob.state == "needs_review",
        )).order_by(FeedItem.discovered_at.desc(), FeedItem.id.desc())
    )
    root = await get_library_root(session)
    results = []
    for item, source, job in rows:
        try:
            parsed = ParsedRelease.model_validate_json(item.parse_data)
        except ValueError:
            parsed = parse_release_title(item.title)
            parsed.warnings.append("保存的解析信息无效，请重新解析")
        season = job.season if job else (
            source.season if source.season is not None else parsed.season
        )
        if not job and "manual_review" in parsed.evidence:
            season = parsed.season
        title = job.title if job else safe_folder_name(
            parsed.title if "manual_review" in parsed.evidence else source.name
        )
        path = None
        if season is not None and parsed.episode_start is not None:
            episode = f"{parsed.episode_start:g}".zfill(2)
            extension = parsed.container or "mkv"
            path = str(path_type(root)(root) / title / f"Season {season:02d}" /
                       f"{title} S{season:02d}E{episode}.{extension}")
        results.append(ReviewRead(
            id=item.id, raw_title=item.title, source_name=source.name,
            source_active=source.active, parsed=parsed, season=season,
            reason=job.last_error if job and job.last_error else
            "；".join(parsed.warnings) or "解析置信度不足，需要确认季与集数",
            proposed_path=path, job_state=job.state if job else None,
        ))
    return results


@router.get("/{item_id}/files")
async def read_files(item_id: int, session: AsyncSession = Depends(get_session)):
    async with queue_lock:
        _, _, job = await load_pending(session, item_id)
        if not job:
            return []
        return [{"name": str(f["name"]).replace("\\", "/"),
                 "episode": parse_release_title(PurePosixPath(f["name"]).stem).episode_start}
                for f in await job_files(session, job)
                if PurePosixPath(f["name"]).suffix.lower() in VIDEO_EXTENSIONS]


@router.post("/{item_id}/ignore", response_model=ApiMessage)
async def ignore(item_id: int, session: AsyncSession = Depends(get_session)):
    async with queue_lock:
        item, _, job = await load_pending(session, item_id)
        require_replacement_settled(job)
        if job:
            await job_files(session, job, stop=True, require_files=False)
            job.state = "ignored"
        item.parse_status = "ignored"
        await _record_and_publish_event(session, "review.ignored", "feed_item", str(item_id),
                                        {"title": item.title})
    return ApiMessage(message="已忽略条目；不会再次自动下载，已有文件保留")


@router.post("/{item_id}/reparse", response_model=ApiMessage)
async def reparse(item_id: int, session: AsyncSession = Depends(get_session)):
    async with queue_lock:
        item, source, job = await load_pending(session, item_id)
        require_replacement_settled(job)
        parsed = parse_release_title(item.title)
        if source.season is not None:
            parsed.season = source.season
        item.parse_data = parsed.model_dump_json()
        # 重新解析仅更新证据，必须显式批准才能解除审核。
        await _record_and_publish_event(session, "review.reparsed", "feed_item", str(item_id),
                                        {"title": item.title, "confidence": parsed.confidence})
    return ApiMessage(message="已重新解析，请确认结果后批准")


@router.post("/{item_id}/approve", response_model=ApiMessage)
async def approve(item_id: int, data: ReviewApproval,
                  session: AsyncSession = Depends(get_session)):
    async with queue_lock:
        item, source, job = await load_pending(session, item_id)
        require_replacement_settled(job)
        title = safe_folder_name(data.title.strip())
        if not data.title.strip() or title != data.title.strip():
            raise HTTPException(422, "番名不能包含路径分隔符或无效文件名字符")
        try:
            parsed = ParsedRelease.model_validate_json(item.parse_data)
        except ValueError:
            parsed = parse_release_title(item.title)
        before = parsed.model_dump()
        parsed.title = title
        parsed.season = data.season
        parsed.episode_start = data.episode
        parsed.episode_end = None
        if "manual_review" not in parsed.evidence:
            parsed.evidence.append("manual_review")
        if job:
            files = await job_files(session, job, stop=True)
            overrides = None
            if data.files is not None:
                overrides = {f.name: f.episode for f in data.files}
                video_names = {str(f["name"]).replace("\\", "/") for f in files
                               if PurePosixPath(f["name"]).suffix.lower() in VIDEO_EXTENSIONS}
                if len(overrides) != len(data.files) or set(overrides) != video_names:
                    raise HTTPException(422, "请为当前全部视频指定集数或跳过，文件名不能重复")
            try:
                plan = build_plan(files, title, data.season, parsed, overrides)
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from exc
            previous_tag = json.loads(job.plan).get("show_tag") if job.plan else None
            if previous_tag:
                plan["show_tag"] = previous_tag
            job.plan = json.dumps(plan, ensure_ascii=False)
            job.title, job.season = title, data.season
            job.state, job.last_error = "organizing", None
        elif data.files is not None:
            raise HTTPException(422, "尚未获取种子文件，不能提交逐文件修正")
        item.parse_data = parsed.model_dump_json()
        item.parse_status = "parsed"
        if not job:
            # 季与番名是此条目的确认值，不修改整个订阅。
            await session.flush()
            try:
                await enqueue_source(session, source)
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from exc
            job = await session.scalar(select(DownloadJob).where(DownloadJob.item_id == item_id))
            if job:
                job.title, job.season = title, data.season
        await _record_and_publish_event(session, "review.approved", "feed_item", str(item_id), {
            "title": item.title, "before": before,
            "correction": data.model_dump(), "queued": bool(job),
        })
    return ApiMessage(message="已批准，下载队列将继续处理" if job else
                      "已保存审核结果；启用订阅并配置下载器后可重新下载")
