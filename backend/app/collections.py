"""单磁力合集：解析原始元数据，确认 TMDB 后接入现有下载和刮削队列。"""

import asyncio
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from time import monotonic
from urllib.parse import parse_qs, urlparse

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .api import _complete_feed_setup, _create_scrape_operation, _validate_feed_prerequisites
from .artwork_service import safe_folder_name
from .collection_plan import build_collection_plan, collection_title, is_extra
from .config import settings
from .database import get_session
from .dependencies import require_user
from .download_queue import VIDEO_EXTENSIONS, queue_lock, remote_root, request
from .downloader_service import extract_info_hash
from .events import commit_and_publish
from .library import get_library_root
from .models import (
    DownloaderConfig,
    DownloadJob,
    FeedItem,
    FeedSource,
    ShowArtwork,
    ShowMetadata,
    User,
)
from .notifications import notify_task
from .release_parser import parse_release_title
from .schemas import FeedRead, TmdbSelection
from .security import decrypt_secret

router = APIRouter(prefix="/api/v1/collections", dependencies=[Depends(require_user)])


@dataclass(slots=True)
class _MetadataSession:
    cookies: httpx.Cookies = field(default_factory=httpx.Cookies)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    last_used: float = field(default_factory=monotonic)


_metadata_sessions: dict[tuple, _MetadataSession] = {}


def _metadata_session(config):
    # qB's preview cache is scoped to a WebUI login, not to the HTTP connection.
    # Keep only cookies: each request still closes its own HTTP client and sockets.
    for key, state in list(_metadata_sessions.items()):
        if monotonic() - state.last_used > 3600 and not state.lock.locked():
            del _metadata_sessions[key]
    key = (
        config.id, config.base_url, config.username, config.encrypted_secret, config.verify_tls
    )
    return _metadata_sessions.setdefault(key, _MetadataSession())


async def _login_metadata_client(client, config):
    login = await request(
        client,
        "POST",
        "auth/login",
        data={
            "username": config.username or "",
            "password": decrypt_secret(config.encrypted_secret) or "",
        },
    )
    if login.status_code != 204 and not login.text.startswith("Ok"):
        raise ValueError("qBittorrent 拒绝登录")


class MagnetRequest(BaseModel):
    magnet: str = Field(min_length=1, max_length=8192)

    @field_validator("magnet")
    @classmethod
    def validate_magnet(cls, value):
        value = value.strip()
        parsed = urlparse(value)
        xt = [x for x in parse_qs(parsed.query).get("xt", []) if x.lower().startswith("urn:btih:")]
        if parsed.scheme.lower() != "magnet" or len(xt) != 1 or not extract_info_hash(value):
            raise ValueError("请输入有效的 BT v1 磁力链接")
        return value


class CollectionCreate(MagnetRequest):
    name: str = Field(min_length=1, max_length=160)
    season: int = Field(ge=0, le=99)
    tmdb: TmdbSelection

    @field_validator("name")
    @classmethod
    def validate_name(cls, value):
        if not value.strip():
            raise ValueError("作品名称不能为空")
        return value.strip()

    @field_validator("tmdb")
    @classmethod
    def validate_tv(cls, value):
        if value.media_type != "tv":
            raise ValueError("剧集合集请选择 TMDB 电视节目条目")
        return value


async def collection_downloader(session):
    config = await session.scalar(
        select(DownloaderConfig)
        .where(
            DownloaderConfig.active.is_(True),
            DownloaderConfig.kind == "qbittorrent",
            DownloaderConfig.organize_strategy == "downloader_managed",
        )
        .order_by(DownloaderConfig.id)
    )
    if not config:
        raise HTTPException(
            409,
            detail={
                "message": "磁力合集需要启用由 qBittorrent 管理整理的下载器。",
                "settings_path": "/settings#downloader",
            },
        )
    return config


async def fetch_metadata(config, magnet):
    state = _metadata_session(config)
    try:
        async with state.lock, httpx.AsyncClient(
            base_url=config.base_url, timeout=15, verify=config.verify_tls, cookies=state.cookies
        ) as client:
            try:
                if not client.cookies:
                    await _login_metadata_client(client, config)
                response = await client.post(
                    "/api/v2/torrents/fetchMetadata", data={"source": magnet}
                )
                if response.status_code in {401, 403}:
                    client.cookies.clear()
                    await _login_metadata_client(client, config)
                    response = await client.post(
                        "/api/v2/torrents/fetchMetadata", data={"source": magnet}
                    )
            finally:
                state.cookies = httpx.Cookies(client.cookies)
                state.last_used = monotonic()
            if response.status_code == 404:
                raise HTTPException(
                    409, "当前 qBittorrent 不支持磁力元数据预览，请升级至 5.2 或更新版本"
                )
            response.raise_for_status()
            if response.status_code == 202:
                return None
            data = response.json()
            if (data.get("infohash_v1") or data.get("hash")) != extract_info_hash(magnet):
                raise ValueError("磁力元数据的哈希不匹配")
            info = data.get("info", {})
            if not info.get("name") or not info.get("files"):
                raise ValueError("磁力元数据没有文件清单")
            return info
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(502, "无法解析磁力元数据，请检查 qBittorrent 连接或重试") from exc


@router.post("/inspect")
async def inspect_collection(data: MagnetRequest, session: AsyncSession = Depends(get_session)):
    config = await collection_downloader(session)
    info = await fetch_metadata(config, data.magnet)
    if info is None:
        return {"status": "pending", "info_hash": extract_info_hash(data.magnet)}
    name, season = collection_title(info["name"])
    files = []
    for f in info["files"]:
        path = PurePosixPath(f["path"])
        parsed = parse_release_title(path.stem)
        video = path.suffix.lower() in VIDEO_EXTENSIONS
        files.append(
            {
                "name": str(path),
                "size": f["length"],
                "episode": parsed.episode_start if video and not is_extra(path) else None,
                "kind": "extra" if is_extra(path) else "video" if video else "attachment",
            }
        )
    return {
        "status": "ready",
        "info_hash": extract_info_hash(data.magnet),
        "raw_title": info["name"],
        "name": name,
        "season": season,
        "size": info["length"],
        "files": files,
    }


@router.post("", response_model=FeedRead, status_code=201)
async def create_collection(
    data: CollectionCreate,
    background_tasks: BackgroundTasks,
    user: User = Depends(require_user),
    session: AsyncSession = Depends(get_session),
):
    await _validate_feed_prerequisites(session)
    config = await collection_downloader(session)
    info_hash = extract_info_hash(data.magnet)
    canonical = f"magnet:?xt=urn:btih:{info_hash}"
    info = await fetch_metadata(config, data.magnet)
    if info is None:
        raise HTTPException(409, "磁力元数据尚未就绪，请等待解析完成后再保存")
    files = [{"name": f["path"], "index": i} for i, f in enumerate(info["files"])]
    release = parse_release_title(info["name"])
    release.evidence.append("magnet_collection")
    release.title = data.name
    release.season = data.season
    try:
        plan = build_collection_plan(files, safe_folder_name(data.name), data.season, release)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    episodes = [
        parse_release_title(PurePosixPath(f["new"]).stem).episode_start
        for f in plan["files"]
        if PurePosixPath(f["new"]).suffix.lower() in VIDEO_EXTENSIONS
    ]
    release.episode_start, release.episode_end = min(episodes), max(episodes)
    release.release_kind = "collection"
    release.warnings = []
    async with queue_lock:
        if await session.scalar(
            select(FeedSource.id).where(FeedSource.url == canonical)
        ) or await session.scalar(select(DownloadJob.id).where(DownloadJob.info_hash == info_hash)):
            raise HTTPException(409, "该磁力合集已经添加")
        root = await get_library_root(session, config.library_root)
        source = FeedSource(
            name=data.name,
            url=canonical,
            kind="magnet",
            season=data.season,
            active=True,
            excluded_keywords=[],
            connection_status="healthy",
            last_checked_at=datetime.now(UTC),
        )
        source.show_metadata = ShowMetadata(
            tmdb_id=data.tmdb.tmdb_id,
            media_type="tv",
            title=data.name,
            href=f"{settings.tmdb_base_url}/tv/{data.tmdb.tmdb_id}",
        )
        source.artwork = ShowArtwork(
            directory=str(Path(root) / safe_folder_name(data.name)), status="pending"
        )
        session.add(source)
        await session.flush()
        item = FeedItem(
            source_id=source.id,
            title=info["name"],
            guid=info_hash,
            download_url=data.magnet,
            info_hash=info_hash,
            fingerprint=info_hash,
            parse_status="parsed",
            parse_data=release.model_dump_json(),
        )
        session.add(item)
        await session.flush()
        session.add(
            DownloadJob(
                item_id=item.id,
                info_hash=info_hash,
                downloader_id=config.id,
                target_root=remote_root(root, config),
                title=safe_folder_name(data.name),
                season=data.season,
                state="queued",
            )
        )
        await notify_task(session, item, "download_added", source=source, user_id=user.id)
        operation = await _create_scrape_operation(session, user.id, source, "feed_scrape")
        try:
            await commit_and_publish(session)
        except IntegrityError as exc:
            await session.rollback()
            raise HTTPException(409, "该磁力合集已经添加") from exc
        await session.refresh(source)
        source.background_operation_ids = [operation.id]
        background_tasks.add_task(_complete_feed_setup, source.id, operation.id)
        return source
