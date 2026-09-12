"""Mooncell HTTP API：认证、订阅、解析、下载器、仪表盘和实时事件。"""

import asyncio
import json
import os
import subprocess
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .artwork_service import (
    ArtworkResult,
    safe_folder_name,
    scrape_and_store_artwork,
    store_uploaded_artwork,
)
from .config import settings
from .database import get_session
from .dependencies import optional_user, require_user
from .downloader_service import extract_info_hash, get_qbittorrent_snapshot, test_downloader
from .events import EventMessage, broker, event_log_fields
from .library import get_library_root
from .models import (
    DomainEvent,
    DownloaderConfig,
    FeedItem,
    FeedSource,
    ShowArtwork,
    ShowMetadata,
    User,
    UserSession,
)
from .providers.tmdb import scrape_tmdb, search_tmdb
from .release_parser import parse_release_title
from .rss_service import FeedRefreshService, describe_rss_exception, inspect_feed
from .schemas import (
    ApiMessage,
    AuthStatus,
    Credentials,
    DashboardSummary,
    DownloadCenterRead,
    DownloaderCreate,
    DownloaderRead,
    DownloaderTestResult,
    DownloaderUpdate,
    DownloadTaskRead,
    FeedCreate,
    FeedInspectRequest,
    FeedInspectResult,
    FeedRead,
    FeedRefreshResult,
    FeedUpdate,
    HealthResponse,
    LogRead,
    ParsedRelease,
    ParseRequest,
    PathPreviewRequest,
    PathPreviewResponse,
    ShowRead,
    TmdbCandidate,
    TmdbMetadata,
    TmdbSearchRequest,
)
from .security import (
    create_user_session,
    decrypt_secret,
    encrypt_secret,
    hash_password,
    token_hash,
    verify_password,
)
from .subscription_settings import get_options

router = APIRouter(prefix="/api/v1")


async def _record_and_publish_event(
    session: AsyncSession,
    event_type: str,
    resource_type: str,
    resource_id: str,
    payload: dict,
) -> None:
    """持久化领域事件并立即广播，让日志页无需刷新即可看到。"""
    event = DomainEvent(
        event_type=event_type,
        resource_type=resource_type,
        resource_id=resource_id,
        payload=json.dumps(payload, ensure_ascii=False),
    )
    session.add(event)
    await session.commit()
    await broker.publish(
        EventMessage(
            id=event.id,
            event_type=event.event_type,
            resource_type=event.resource_type,
            resource_id=event.resource_id,
            payload=payload,
            created_at=event.created_at,
        )
    )


def _set_session_cookie(response: Response, token: str) -> None:
    """通过 HttpOnly Cookie 下发会话，阻止前端脚本读取原始令牌。"""
    response.set_cookie(
        settings.session_cookie_name,
        token,
        max_age=settings.session_days * 86400,
        httponly=True,
        secure=settings.session_cookie_secure,
        samesite="strict",
        path="/",
    )


@router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse()


@router.get("/auth/status", response_model=AuthStatus)
async def auth_status(
    session: AsyncSession = Depends(get_session), user: User | None = Depends(optional_user)
) -> AuthStatus:
    initialized = bool(await session.scalar(select(func.count(User.id))))
    return AuthStatus(
        initialized=initialized,
        authenticated=user is not None,
        username=user.username if user else None,
    )


@router.post("/auth/bootstrap", response_model=AuthStatus, status_code=status.HTTP_201_CREATED)
async def bootstrap(
    credentials: Credentials,
    response: Response,
    session: AsyncSession = Depends(get_session),
) -> AuthStatus:
    """首次启动时创建唯一管理员；已有账户后永久关闭该入口。"""
    if await session.scalar(select(func.count(User.id))):
        raise HTTPException(status_code=409, detail="Mooncell 已完成初始化")
    user = User(username=credentials.username, password_hash=hash_password(credentials.password))
    session.add(user)
    await session.flush()
    token = await create_user_session(session, user.id)
    await session.commit()
    _set_session_cookie(response, token)
    return AuthStatus(initialized=True, authenticated=True, username=user.username)


@router.post("/auth/login", response_model=AuthStatus)
async def login(
    credentials: Credentials,
    response: Response,
    session: AsyncSession = Depends(get_session),
) -> AuthStatus:
    user = await session.scalar(select(User).where(User.username == credentials.username))
    if user is None or not verify_password(credentials.password, user.password_hash):
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    token = await create_user_session(session, user.id)
    await session.commit()
    _set_session_cookie(response, token)
    return AuthStatus(initialized=True, authenticated=True, username=user.username)


@router.post("/auth/logout", response_model=ApiMessage)
async def logout(
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_session),
) -> ApiMessage:
    raw_token = request.cookies.get(settings.session_cookie_name)
    if raw_token:
        await session.execute(
            delete(UserSession).where(UserSession.token_hash == token_hash(raw_token))
        )
        await session.commit()
    response.delete_cookie(settings.session_cookie_name, path="/")
    return ApiMessage(message="已退出登录")


@router.get("/feeds", response_model=list[FeedRead])
async def list_feeds(
    _user: User = Depends(require_user), session: AsyncSession = Depends(get_session)
) -> list[FeedSource]:
    result = await session.scalars(select(FeedSource).order_by(FeedSource.created_at.desc()))
    return list(result)


@router.post("/feeds", response_model=FeedRead, status_code=status.HTTP_201_CREATED)
async def create_feed(
    data: FeedCreate,
    _user: User = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> FeedSource:
    if await session.scalar(select(FeedSource.id).where(FeedSource.url == str(data.url))):
        raise HTTPException(status_code=409, detail="该 RSS 源已经存在")
    feed_name = data.name.strip() if data.name else ""
    feed_kind = data.kind
    if not feed_name:
        try:
            inspection = await inspect_feed(str(data.url))
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"无法读取 RSS：{exc}") from exc
        feed_name = inspection.name
        feed_kind = inspection.kind
    source = FeedSource(
        name=feed_name,
        url=str(data.url),
        kind=feed_kind,
        season=data.season,
        excluded_keywords=data.excluded_keywords,
        active=data.active,
        refresh_interval_minutes=(await get_options(session)).refresh_interval_minutes,
    )
    if data.tmdb:
        metadata_error: str | None = None
        try:
            metadata = await scrape_tmdb(data.tmdb.tmdb_id, data.tmdb.media_type)
        except Exception as exc:
            # 元数据服务短暂不可用时仍保存订阅，用户之后可从番剧页重新刮削。
            metadata_error = f"{exc.__class__.__name__}: {str(exc).strip()}".rstrip(": ")
            metadata = TmdbMetadata(
                tmdb_id=data.tmdb.tmdb_id,
                media_type=data.tmdb.media_type,
                title=feed_name,
                href=f"{settings.tmdb_base_url}/{data.tmdb.media_type}/{data.tmdb.tmdb_id}",
            )
        source.show_metadata = ShowMetadata(
            tmdb_id=metadata.tmdb_id,
            media_type=metadata.media_type,
            title=metadata.title,
            overview=metadata.overview,
            poster_url=metadata.poster_url,
            release_date=metadata.release_date,
            genres_json=json.dumps(metadata.genres, ensure_ascii=False),
            episode_count=metadata.episode_count,
            rating=metadata.rating,
            vote_count=metadata.vote_count,
            href=metadata.href,
        )
        downloader = await session.scalar(
            select(DownloaderConfig).where(DownloaderConfig.active.is_(True)).limit(1)
        )
        try:
            artwork = await scrape_and_store_artwork(
                feed_name, metadata,
                await get_library_root(session, downloader.library_root if downloader else None),
            )
            if metadata_error and not artwork.error:
                artwork.error = metadata_error
                artwork.status = "partial"
        except Exception as exc:
            directory = Path(await get_library_root(session)) / safe_folder_name(feed_name)
            artwork = ArtworkResult(
                directory=str(directory),
                poster_path=None,
                fanart_path=None,
                clearlogo_path=None,
                status="failed",
                error=f"{exc.__class__.__name__}: {str(exc).strip()}".rstrip(": "),
                scraped_at=datetime.now(UTC),
            )
        source.artwork = ShowArtwork(
            directory=artwork.directory,
            poster_path=artwork.poster_path,
            fanart_path=artwork.fanart_path,
            clearlogo_path=artwork.clearlogo_path,
            status=artwork.status,
            last_error=artwork.error,
            scraped_at=artwork.scraped_at,
        )
    session.add(source)
    await session.commit()
    await session.refresh(source)
    return source


@router.post("/feeds/inspect", response_model=FeedInspectResult)
async def inspect_feed_endpoint(
    data: FeedInspectRequest, _user: User = Depends(require_user)
) -> FeedInspectResult:
    """在保存前读取 RSS 频道标题，并生成可编辑的订阅名称。"""
    try:
        return await inspect_feed(str(data.url))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"无法读取 RSS：{exc}") from exc


@router.post("/tmdb/search", response_model=list[TmdbCandidate])
async def tmdb_search_endpoint(
    data: TmdbSearchRequest, _user: User = Depends(require_user)
) -> list[TmdbCandidate]:
    """返回 TMDB 搜索页中的电视和电影候选列表。"""
    try:
        return await search_tmdb(data.query.strip())
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"无法搜索 TMDB：{exc}") from exc


@router.get("/tmdb/{media_type}/{tmdb_id}", response_model=TmdbMetadata)
async def tmdb_detail_endpoint(
    media_type: str, tmdb_id: int, _user: User = Depends(require_user)
) -> TmdbMetadata:
    """按搜索结果 href 中的媒体类型与数字 ID 刮削详情。"""
    if media_type not in {"tv", "movie"}:
        raise HTTPException(status_code=422, detail="TMDB 类型必须是 tv 或 movie")
    try:
        return await scrape_tmdb(tmdb_id, media_type)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"无法刮削 TMDB：{exc}") from exc


@router.patch("/feeds/{source_id}", response_model=FeedRead)
async def update_feed(
    source_id: int,
    data: FeedUpdate,
    _user: User = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> FeedSource:
    source = await session.get(FeedSource, source_id)
    if source is None:
        raise HTTPException(status_code=404, detail="RSS 源不存在")
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(source, key, str(value) if key == "url" else value)
    await session.commit()
    await session.refresh(source)
    return source


@router.delete("/feeds/{source_id}", response_model=ApiMessage)
async def delete_feed(
    source_id: int,
    _user: User = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> ApiMessage:
    source = await session.get(FeedSource, source_id)
    if source is None:
        raise HTTPException(status_code=404, detail="RSS 源不存在")
    await session.delete(source)
    await session.commit()
    return ApiMessage(message="RSS 源已删除")


@router.post("/feeds/{source_id}/refresh", response_model=FeedRefreshResult)
async def refresh_feed(
    source_id: int,
    _user: User = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> FeedRefreshResult:
    """手动刷新订阅源；未来的定时调度器也调用同一个领域服务。"""
    source = await session.get(FeedSource, source_id)
    if source is None:
        raise HTTPException(status_code=404, detail="RSS 源不存在")
    try:
        return await FeedRefreshService(session).refresh(source)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=describe_rss_exception(exc)) from exc


def _show_read(source: FeedSource, discovered_items: int) -> ShowRead:
    """将订阅、TMDB 元数据和本地图片状态组合为番剧页的单一视图。"""
    metadata = source.show_metadata
    artwork = source.artwork

    def ready(path: str | None) -> bool:
        return bool(path and Path(path).is_file())

    return ShowRead(
        id=source.id,
        name=source.name,
        active=source.active,
        created_at=source.created_at,
        tmdb_id=metadata.tmdb_id if metadata else None,
        tmdb_url=metadata.href if metadata else None,
        media_type=metadata.media_type if metadata else None,
        metadata_title=metadata.title if metadata else None,
        overview=metadata.overview if metadata else None,
        release_date=metadata.release_date if metadata else None,
        episode_count=metadata.episode_count if metadata else None,
        rating=metadata.rating if metadata else None,
        poster_url=metadata.poster_url if metadata else None,
        discovered_items=discovered_items,
        artwork_status=artwork.status if artwork else "missing",
        artwork_version=artwork.scraped_at.isoformat() if artwork and artwork.scraped_at else None,
        poster_ready=ready(artwork.poster_path) if artwork else False,
        fanart_ready=ready(artwork.fanart_path) if artwork else False,
        clearlogo_ready=ready(artwork.clearlogo_path) if artwork else False,
    )


@router.get("/shows", response_model=list[ShowRead])
async def list_shows(
    _user: User = Depends(require_user), session: AsyncSession = Depends(get_session)
) -> list[ShowRead]:
    """从数据库读取所有订阅，并附带已发现剧集数量和三图落盘状态。"""
    rows = (
        await session.execute(
            select(FeedSource, func.count(FeedItem.id))
            .outerjoin(FeedItem, FeedItem.source_id == FeedSource.id)
            .group_by(FeedSource.id)
            .order_by(FeedSource.created_at.desc())
        )
    ).all()
    return [_show_read(source, count) for source, count in rows]


@router.get("/shows/{source_id}/items", response_model=list[str])
async def list_show_item_titles(
    source_id: int,
    _user: User = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> list[str]:
    """返回指定番剧 RSS 中已发现条目的原始标题。"""
    source_exists = await session.scalar(
        select(FeedSource.id).where(FeedSource.id == source_id)
    )
    if source_exists is None:
        raise HTTPException(status_code=404, detail="番剧订阅不存在")

    titles = await session.scalars(
        select(FeedItem.title)
        .where(FeedItem.source_id == source_id)
        .order_by(FeedItem.published_at.desc(), FeedItem.discovered_at.desc(), FeedItem.id.desc())
    )
    return list(titles)


@router.post("/shows/{source_id}/rescrape", response_model=ShowRead)
async def rescrape_show_artwork(
    source_id: int,
    _user: User = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> ShowRead:
    """重新获取 TMDB 元数据与三图；失败状态会被保留供界面重试。"""
    source = await session.get(FeedSource, source_id)
    if source is None:
        raise HTTPException(status_code=404, detail="番剧订阅不存在")
    metadata = source.show_metadata
    if metadata is None:
        raise HTTPException(status_code=409, detail="该订阅尚未关联 TMDB，无法刮削图片")

    await _record_and_publish_event(
        session,
        "artwork.scrape.started",
        "feed_source",
        str(source.id),
        {"name": source.name, "tmdbId": metadata.tmdb_id},
    )

    try:
        refreshed = await scrape_tmdb(metadata.tmdb_id, metadata.media_type)
        for field in (
            "title", "overview", "poster_url", "release_date", "episode_count", "rating",
            "vote_count", "href",
        ):
            setattr(metadata, field, getattr(refreshed, field))
        metadata.genres_json = json.dumps(refreshed.genres, ensure_ascii=False)
        metadata.scraped_at = datetime.now(UTC)
        downloader = await session.scalar(
            select(DownloaderConfig).where(DownloaderConfig.active.is_(True)).limit(1)
        )
        result = await scrape_and_store_artwork(
            source.name, refreshed,
            await get_library_root(session, downloader.library_root if downloader else None),
        )
    except Exception as exc:
        existing = source.artwork
        result = ArtworkResult(
            directory=existing.directory if existing else str(
                Path(await get_library_root(session)) / safe_folder_name(source.name)
            ),
            poster_path=existing.poster_path if existing else None,
            fanart_path=existing.fanart_path if existing else None,
            clearlogo_path=existing.clearlogo_path if existing else None,
            status="failed",
            error=f"{exc.__class__.__name__}: {str(exc).strip()}".rstrip(": "),
            scraped_at=datetime.now(UTC),
        )

    if source.artwork is None:
        source.artwork = ShowArtwork(directory=result.directory)
    source.artwork.directory = result.directory
    source.artwork.poster_path = result.poster_path
    source.artwork.fanart_path = result.fanart_path
    source.artwork.clearlogo_path = result.clearlogo_path
    source.artwork.status = result.status
    source.artwork.last_error = result.error
    source.artwork.scraped_at = result.scraped_at
    event_type = {
        "completed": "artwork.scrape.completed",
        "partial": "artwork.scrape.partial",
        "failed": "artwork.scrape.failed",
    }.get(result.status, "artwork.scrape.failed")
    await _record_and_publish_event(
        session,
        event_type,
        "feed_source",
        str(source.id),
        {
            "name": source.name,
            "tmdbId": metadata.tmdb_id,
            "error": result.error,
            "posterReady": bool(result.poster_path),
            "fanartReady": bool(result.fanart_path),
            "clearlogoReady": bool(result.clearlogo_path),
        },
    )
    count = await session.scalar(
        select(func.count(FeedItem.id)).where(FeedItem.source_id == source.id)
    )
    return _show_read(source, count or 0)


@router.post("/shows/{source_id}/artwork/{kind}", response_model=ShowRead)
async def upload_show_artwork(
    source_id: int, kind: str, request: Request,
    _user: User = Depends(require_user), session: AsyncSession = Depends(get_session),
) -> ShowRead:
    if kind not in {"poster", "fanart", "clearlogo"}:
        raise HTTPException(422, "不支持的图片类型")
    source = await session.get(FeedSource, source_id)
    if source is None:
        raise HTTPException(404, "番剧不存在")
    try:
        content = bytearray()
        async for chunk in request.stream():
            content.extend(chunk)
            if len(content) > 10 * 1024 * 1024:
                raise HTTPException(413, "图片不能超过 10 MB")
        directory = Path(await get_library_root(session)) / safe_folder_name(source.name)
        path = await asyncio.to_thread(store_uploaded_artwork, bytes(content), directory, kind)
        if source.artwork is None:
            source.artwork = ShowArtwork(directory=str(directory))
        artwork = source.artwork
        setattr(artwork, f"{kind}_path", str(path))
        artwork.directory = str(directory)
        artwork.scraped_at = datetime.now(UTC)
        artwork.status = "completed" if all(
            value and Path(value).is_file() for value in
            [artwork.poster_path, artwork.fanart_path, artwork.clearlogo_path]
        ) else "partial"
        artwork.last_error = None
        await _record_and_publish_event(session, "artwork.upload.completed", "feed_source",
                                        str(source_id), {"name": source.name, "kind": kind})
    except (ValueError, OSError, subprocess.SubprocessError, HTTPException) as exc:
        detail = exc.detail if isinstance(exc, HTTPException) else str(exc)
        await _record_and_publish_event(session, "artwork.upload.failed", "feed_source",
                                        str(source_id), {"name": source.name, "kind": kind,
                                                         "error": detail})
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(422, "图片上传失败，请确认文件有效并查看实时日志。") from exc
    count = await session.scalar(
        select(func.count(FeedItem.id)).where(FeedItem.source_id == source_id)
    )
    return _show_read(source, count or 0)


@router.get("/shows/{source_id}/artwork/{kind}", response_class=FileResponse)
async def show_artwork_file(
    source_id: int,
    kind: str,
    _user: User = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> FileResponse:
    """通过认证接口读取本地图片，避免向浏览器暴露服务器文件路径。"""
    if kind not in {"poster", "fanart", "clearlogo"}:
        raise HTTPException(status_code=404, detail="图片类型不存在")
    source = await session.get(FeedSource, source_id)
    artwork = source.artwork if source else None
    path_value = getattr(artwork, f"{kind}_path", None) if artwork else None
    path = Path(path_value) if path_value else None
    if path is None or not path.is_file():
        raise HTTPException(status_code=404, detail="图片尚未刮削")
    return FileResponse(path)


@router.post("/shows/{source_id}/open-folder", response_model=ApiMessage)
async def open_show_folder(
    source_id: int,
    _user: User = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> ApiMessage:
    """在运行后端的本机资源管理器中打开番剧目录。"""
    source = await session.get(FeedSource, source_id)
    artwork = source.artwork if source else None
    if source is None:
        raise HTTPException(status_code=404, detail="番剧订阅不存在")
    directory = Path(artwork.directory) if artwork else (
        Path(await get_library_root(session)) / safe_folder_name(source.name)
    )
    directory = directory.resolve()
    if not directory.is_dir():
        raise HTTPException(status_code=404, detail="番剧目录尚未创建")
    try:
        if os.name == "nt":
            subprocess.Popen(["explorer.exe", str(directory)])
        else:
            subprocess.Popen(["xdg-open", str(directory)])
    except OSError as exc:
        raise HTTPException(status_code=500, detail="无法打开本地文件夹") from exc
    return ApiMessage(message="已打开番剧文件夹")


@router.post("/parser/preview", response_model=ParsedRelease)
async def parser_preview(data: ParseRequest, _user: User = Depends(require_user)) -> ParsedRelease:
    return parse_release_title(data.title)


@router.get("/downloaders", response_model=list[DownloaderRead])
async def list_downloaders(
    _user: User = Depends(require_user), session: AsyncSession = Depends(get_session)
) -> list[DownloaderConfig]:
    result = await session.scalars(
        select(DownloaderConfig).order_by(DownloaderConfig.created_at.desc())
    )
    return list(result)


@router.post("/downloaders", response_model=DownloaderRead, status_code=status.HTTP_201_CREATED)
async def create_downloader(
    data: DownloaderCreate,
    _user: User = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> DownloaderConfig:
    downloader = DownloaderConfig(
        **data.model_dump(exclude={"secret"}), encrypted_secret=encrypt_secret(data.secret)
    )
    session.add(downloader)
    await session.commit()
    await session.refresh(downloader)
    return downloader


@router.patch("/downloaders/{downloader_id}", response_model=DownloaderRead)
async def update_downloader(
    downloader_id: int,
    data: DownloaderUpdate,
    _user: User = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> DownloaderConfig:
    """更新单一下载器配置；密码留空时保留当前加密凭据。"""
    downloader = await session.get(DownloaderConfig, downloader_id)
    if downloader is None:
        raise HTTPException(status_code=404, detail="下载器不存在")
    values = data.model_dump(exclude={"secret"})
    for key, value in values.items():
        setattr(downloader, key, value)
    if data.secret:
        downloader.encrypted_secret = encrypt_secret(data.secret)
    downloader.connection_status = "unknown"
    downloader.last_error = None
    await session.commit()
    await session.refresh(downloader)
    return downloader


@router.post("/downloaders/test", response_model=DownloaderTestResult)
async def test_downloader_payload(
    data: DownloaderCreate, _user: User = Depends(require_user)
) -> DownloaderTestResult:
    return await test_downloader(
        data.kind, data.base_url, data.username, data.secret, data.verify_tls
    )


@router.post("/downloaders/{downloader_id}/test", response_model=DownloaderTestResult)
async def test_saved_downloader(
    downloader_id: int,
    _user: User = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> DownloaderTestResult:
    downloader = await session.get(DownloaderConfig, downloader_id)
    if downloader is None:
        raise HTTPException(status_code=404, detail="下载器不存在")
    result = await test_downloader(
        downloader.kind,
        downloader.base_url,
        downloader.username,
        decrypt_secret(downloader.encrypted_secret),
        downloader.verify_tls,
    )
    downloader.connection_status = "healthy" if result.ok else "error"
    downloader.last_checked_at = datetime.now(UTC)
    downloader.last_error = None if result.ok else result.message
    await session.commit()
    return result


def _download_status(state: str | None, progress: float) -> str:
    """把 qBittorrent 原始状态归一化为前端稳定状态。"""
    if progress >= 1:
        return "completed"
    if not state:
        return "not_added"
    lowered = state.lower()
    if "error" in lowered or "missing" in lowered:
        return "failed"
    if "paused" in lowered or "stopped" in lowered:
        return "paused"
    if "queued" in lowered:
        return "queued"
    if "check" in lowered or "meta" in lowered:
        return "checking"
    return "downloading"


@router.get("/downloads", response_model=DownloadCenterRead)
async def download_center(
    _user: User = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> DownloadCenterRead:
    """以数据库 RSS 下载记录为主表，实时合并 qBittorrent 状态。"""
    rows = list(
        (
            await session.execute(
                select(FeedItem, FeedSource.name)
                .join(FeedSource, FeedItem.source_id == FeedSource.id)
                .where(FeedItem.download_url.is_not(None))
                .order_by(FeedItem.discovered_at.desc())
                .limit(500)
            )
        ).all()
    )
    records = [
        (item, source_name, item.info_hash or extract_info_hash(item.download_url))
        for item, source_name in rows
    ]
    downloader = await session.scalar(
        select(DownloaderConfig)
        .where(DownloaderConfig.active.is_(True), DownloaderConfig.kind == "qbittorrent")
        .order_by(DownloaderConfig.id)
    )
    snapshot = None
    error = None
    if downloader:
        try:
            snapshot = await get_qbittorrent_snapshot(
                downloader.base_url,
                downloader.username,
                decrypt_secret(downloader.encrypted_secret),
                downloader.verify_tls,
                [info_hash for _item, _source, info_hash in records if info_hash],
            )
        except Exception as exc:
            error = f"{exc.__class__.__name__}: {str(exc).strip()}".rstrip(": ")

    tasks: list[DownloadTaskRead] = []
    from .models import DownloadJob

    jobs = {job.item_id: job for job in await session.scalars(select(DownloadJob))}
    for item, source_name, info_hash in records:
        job = jobs.get(item.id)
        torrent = snapshot.torrents.get(info_hash) if snapshot and info_hash else None
        progress = float(torrent.get("progress", 0)) if torrent else 0
        raw_eta = int(torrent.get("eta", 0)) if torrent else None
        size = max(0, int(torrent.get("size", 0))) if torrent else 0
        # Use selected file completion, not cumulative traffic (which includes re-downloads).
        remaining = int(torrent.get("amount_left", size)) if torrent else 0
        downloaded = max(0, min(size, size - remaining))
        tasks.append(
            DownloadTaskRead(
                source_id=item.source_id,
                automation_state=job.state if job else None,
                automation_error=job.last_error if job else None,
                id=item.id,
                title=item.title,
                source_name=source_name,
                download_url=item.download_url or "",
                info_hash=info_hash,
                published_at=item.published_at,
                discovered_at=item.discovered_at,
                matched=torrent is not None,
                status=_download_status(torrent.get("state") if torrent else None, progress),
                qb_state=torrent.get("state") if torrent else None,
                progress=round(progress * 100, 2),
                download_speed=int(torrent.get("dlspeed", 0)) if torrent else 0,
                upload_speed=int(torrent.get("upspeed", 0)) if torrent else 0,
                eta=None if raw_eta is None or raw_eta >= 8_640_000 else raw_eta,
                size=size,
                downloaded=downloaded,
            )
        )
    return DownloadCenterRead(
        downloader_configured=downloader is not None,
        downloader_online=snapshot is not None,
        downloader_name=downloader.name if downloader else None,
        downloader_version=snapshot.version if snapshot else None,
        download_speed=snapshot.download_speed if snapshot else 0,
        upload_speed=snapshot.upload_speed if snapshot else 0,
        error=error,
        tasks=tasks,
    )


@router.post("/setup/path-preview", response_model=PathPreviewResponse)
async def path_preview(
    data: PathPreviewRequest, _user: User = Depends(require_user)
) -> PathPreviewResponse:
    """只计算目标路径，不接触真实文件系统。"""
    sample = f"[ANi] {data.title} - {data.episode:g} [1080P][WEB-DL][CHT]"
    parsed = parse_release_title(sample)
    folder_name = data.canonical_title
    season_folder = f"Season {data.season:02d}"
    raw_episode = f"{data.episode:g}"
    episode_text = raw_episode.zfill(2) if data.episode < 10 else raw_episode
    filename = f"{data.canonical_title} S{data.season:02d}E{episode_text}{data.extension}"
    library_root = Path(data.library_root)
    directory = library_root / folder_name / season_folder
    full_path = str(directory / filename)
    return PathPreviewResponse(
        parsed=parsed,
        directory=str(directory),
        filename=filename,
        full_path=full_path,
        library_root=str(library_root),
        folder_name=folder_name,
        season_folder=season_folder,
        separator=os.sep,
    )


@router.get("/dashboard", response_model=DashboardSummary)
async def dashboard(
    _user: User = Depends(require_user), session: AsyncSession = Depends(get_session)
) -> DashboardSummary:
    feeds = int(await session.scalar(select(func.count(FeedSource.id))) or 0)
    healthy_feeds = int(
        await session.scalar(
            select(func.count(FeedSource.id)).where(FeedSource.connection_status == "healthy")
        )
        or 0
    )
    discovered_items = int(await session.scalar(select(func.count(FeedItem.id))) or 0)
    needs_review = int(
        await session.scalar(
            select(func.count(FeedItem.id)).where(FeedItem.parse_status == "needs_review")
        )
        or 0
    )
    downloaders = int(await session.scalar(select(func.count(DownloaderConfig.id))) or 0)
    healthy_downloaders = int(
        await session.scalar(
            select(func.count(DownloaderConfig.id)).where(
                DownloaderConfig.connection_status == "healthy"
            )
        )
        or 0
    )
    recent = await session.scalars(
        select(FeedItem).order_by(FeedItem.discovered_at.desc()).limit(6)
    )
    recent_items = [
        {
            "id": item.id,
            "title": item.title,
            "status": item.parse_status,
            "publishedAt": item.published_at.isoformat() if item.published_at else None,
            "parsed": json.loads(item.parse_data),
        }
        for item in recent
    ]
    return DashboardSummary(
        feeds=feeds,
        healthy_feeds=healthy_feeds,
        discovered_items=discovered_items,
        needs_review=needs_review,
        downloaders=downloaders,
        healthy_downloaders=healthy_downloaders,
        recent_items=recent_items,
    )


@router.get("/logs", response_model=list[LogRead])
async def list_logs(
    limit: int = 200,
    _user: User = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> list[LogRead]:
    """返回最近的持久化领域日志，供页面首次加载和 SSE 断线补偿。"""
    safe_limit = min(max(limit, 1), 1000)
    events = list(
        await session.scalars(
            select(DomainEvent).order_by(DomainEvent.id.desc()).limit(safe_limit)
        )
    )
    result: list[LogRead] = []
    for event in events:
        payload = json.loads(event.payload)
        level, scope, message = event_log_fields(event.event_type, payload)
        result.append(
            LogRead(
                id=event.id,
                occurred_at=event.created_at,
                level=level,
                scope=scope,
                event_type=event.event_type,
                message=message,
            )
        )
    return result


@router.get("/events/stream")
async def event_stream(
    request: Request,
    _user: User = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> StreamingResponse:
    """先补发断线期间的持久化事件，再切换到实时进程内事件流。"""
    last_event_header = request.headers.get("last-event-id") or request.query_params.get(
        "lastEventId", "0"
    )
    try:
        last_event_id = int(last_event_header)
    except ValueError:
        last_event_id = 0

    # EventSource 会携带最后收到的 ID；限制补发量以控制单次响应大小。
    historical = list(
        await session.scalars(
            select(DomainEvent)
            .where(DomainEvent.id > last_event_id)
            .order_by(DomainEvent.id)
            .limit(200)
        )
    )

    async def generate() -> AsyncIterator[str]:
        for event in historical:
            message = EventMessage(
                id=event.id,
                event_type=event.event_type,
                resource_type=event.resource_type,
                resource_id=event.resource_id,
                payload=json.loads(event.payload),
                created_at=event.created_at,
            )
            yield message.as_sse()
            yield message.as_sse("log")
        async with broker.subscribe() as queue:
            while not await request.is_disconnected():
                try:
                    message = await asyncio.wait_for(queue.get(), timeout=15)
                    yield message.as_sse()
                    yield message.as_sse("log")
                except TimeoutError:
                    # 注释帧不会触发浏览器事件，但能防止代理关闭空闲连接。
                    yield ": heartbeat\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
