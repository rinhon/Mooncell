"""媒体信息、字幕、续播与服务器能力接口。"""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import and_, or_
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_session
from ..dependencies import require_user
from ..models import MediaFile, PlaybackProgress, User
from .media import MediaError, resolve_media
from .metadata import persist_probe
from .probe import playback_capabilities, probe_media, subtitle_content
from .schemas import PlaybackCapabilities, PlaybackInfo, ProgressRead, ProgressUpdate

router = APIRouter(prefix="/api/v1")
NO_STORE = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}


def media_http_error(error: MediaError) -> HTTPException:
    return HTTPException(error.status, {"code": error.code, "message": error.message})


async def require_playback_user(
    user: User = Depends(require_user), session: AsyncSession = Depends(get_session),
) -> int:
    user_id = user.id
    # 与 require_user 共用的认证会话在视频或字幕传输开始前归还连接。
    await session.close()
    return user_id


def progress_read(row: PlaybackProgress | None) -> ProgressRead:
    if row is None:
        return ProgressRead()
    return ProgressRead(position=row.position, duration=row.duration, completed=row.completed,
                        updated_at=row.updated_at)


@router.get("/media/{media_id}/playback-info", response_model=PlaybackInfo)
async def playback_info(
    media_id: str, response: Response, user_id: int = Depends(require_playback_user),
    session: AsyncSession = Depends(get_session),
) -> PlaybackInfo:
    response.headers.update(NO_STORE)
    try:
        media = await resolve_media(session, media_id)
        saved = progress_read(await session.get(PlaybackProgress, (user_id, media_id)))
        await session.close()
        info = await probe_media(media)
        await persist_probe(session, media, info)
        info.progress = saved
        return info
    except MediaError as error:
        raise media_http_error(error) from error


@router.get("/media/{media_id}/subtitles/{track_id}")
async def subtitle(
    media_id: str, track_id: str, _user_id: int = Depends(require_playback_user),
    session: AsyncSession = Depends(get_session),
) -> Response:
    try:
        media = await resolve_media(session, media_id)
        await session.close()
        return Response(await subtitle_content(media, track_id), media_type="text/vtt",
                        headers=NO_STORE)
    except MediaError as error:
        raise media_http_error(error) from error


@router.get("/media/{media_id}/progress", response_model=ProgressRead)
async def get_progress(
    media_id: str, response: Response, user_id: int = Depends(require_playback_user),
    session: AsyncSession = Depends(get_session),
) -> ProgressRead:
    response.headers.update(NO_STORE)
    if await session.get(MediaFile, media_id) is None:
        raise HTTPException(404, {"code": "media_not_found", "message": "媒体不存在"})
    result = progress_read(await session.get(PlaybackProgress, (user_id, media_id)))
    await session.close()
    return result


async def save_progress(
    session: AsyncSession, user_id: int, media_id: str, data: ProgressUpdate,
    session_created_at: datetime, duration: float,
) -> ProgressRead:
    """数据库条件更新同时抵御同代次乱序、旧代次和旧会话覆盖。"""
    values = dict(
        user_id=user_id, media_id=media_id, position=min(data.position, duration),
        duration=duration, completed=data.completed and data.position >= max(0, duration - 30),
        session_id=data.session_id, session_created_at=session_created_at,
        generation=data.generation, sequence=data.sequence, updated_at=datetime.now(UTC),
    )
    newer = or_(
        PlaybackProgress.session_created_at < session_created_at,
        and_(PlaybackProgress.session_id == data.session_id, or_(
            PlaybackProgress.generation < data.generation,
            and_(PlaybackProgress.generation == data.generation,
                 PlaybackProgress.sequence < data.sequence),
        )),
    )
    await session.execute(insert(PlaybackProgress).values(**values).on_conflict_do_update(
        index_elements=["user_id", "media_id"], set_=values, where=newer,
    ))
    await session.commit()
    # populate_existing 避免已缓存 ORM 对象掩盖条件写入结果。
    row = await session.get(PlaybackProgress, (user_id, media_id), populate_existing=True)
    result = progress_read(row)
    await session.close()
    return result


@router.put("/media/{media_id}/progress", response_model=ProgressRead)
async def put_progress(
    media_id: str, data: ProgressUpdate, response: Response,
    user_id: int = Depends(require_playback_user), session: AsyncSession = Depends(get_session),
) -> ProgressRead:
    from .sessions import manager

    response.headers.update(NO_STORE)
    try:
        if await session.get(MediaFile, media_id) is None:
            raise MediaError("media_not_found", "媒体不存在", 404)
        # 已建立会话持有权威时长；迁移等待或文件移动后仍允许保存该会话进度。
        created_at = manager.validate_progress(user_id, media_id, data.session_id, data.generation,
                                              data.seek_revision)
        duration = manager.get(user_id, data.session_id).info.duration
        return await save_progress(session, user_id, media_id, data, created_at, duration)
    except MediaError as error:
        raise media_http_error(error) from error


@router.get("/settings/playback/capabilities", response_model=PlaybackCapabilities)
async def capabilities(
    response: Response, _user_id: int = Depends(require_playback_user),
) -> PlaybackCapabilities:
    response.headers.update(NO_STORE)
    return await playback_capabilities()
