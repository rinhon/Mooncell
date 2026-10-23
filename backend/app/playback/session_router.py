"""播放控制和同源鉴权媒体传输，数据库事务不跨越 FFmpeg/文件响应。"""

import asyncio
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.types import Receive, Scope, Send

from ..database import get_session
from . import leases
from .direct import DirectFileResponse
from .media import MediaError, resolve_media
from .metadata import persist_probe
from .planner import MAX_TOTAL_BITRATE, MIN_TOTAL_BITRATE
from .probe import probe_media
from .router import require_playback_user
from .schemas import ClientPlaybackCapabilities
from .sessions import manager

router = APIRouter(prefix="/playback/sessions", tags=["playback"])


class CreateSession(BaseModel):
    media_id: str = Field(min_length=1, max_length=64)
    start_time: float = Field(default=0, ge=0, allow_inf_nan=False)
    quality: int = 720
    audio_track: int | None = None
    request_id: UUID
    client_id: UUID | None = None
    capabilities: ClientPlaybackCapabilities | None = None
    force_transcode: bool = False
    max_bitrate: int | None = Field(default=None, ge=MIN_TOTAL_BITRATE, le=MAX_TOTAL_BITRATE)


class SeekSession(BaseModel):
    generation: int = Field(ge=1)
    position: float = Field(ge=0, allow_inf_nan=False)
    request_id: UUID
    client_buffered: bool = False


class SessionOptions(SeekSession):
    quality: int | None = None
    audio_track: int | None = None
    capabilities: ClientPlaybackCapabilities | None = None
    force_transcode: bool | None = None
    max_bitrate: int | None = Field(default=None, ge=MIN_TOTAL_BITRATE, le=MAX_TOTAL_BITRATE)


class Heartbeat(BaseModel):
    generation: int = Field(ge=1)
    position: float = Field(ge=0, allow_inf_nan=False)
    paused: bool
    playback_rate: float = Field(default=1, ge=0.25, le=4, allow_inf_nan=False)
    seek_revision: int | None = Field(default=None, ge=0)


class SegmentResponse(StreamingResponse):
    """整个 ASGI 响应负责租约，包含 response.start 失败与迭代前断开。"""

    def __init__(self, segment, content, headers):
        super().__init__(content, media_type="video/mp2t", headers=headers)
        self.segment = segment

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            await asyncio.shield(manager.release_segment(self.segment))


def error(exc: MediaError) -> HTTPException:
    return HTTPException(exc.status, detail={"code": exc.code, "message": exc.message})


@router.post("", status_code=202)
async def create_session(body: CreateSession, user_id: int = Depends(require_playback_user),
                         database: AsyncSession = Depends(get_session)):
    try:
        media = await resolve_media(database, body.media_id)
        await database.close()
        info = await probe_media(media)
        await persist_probe(database, media, info)
        return await manager.create(user_id, media, info, body.start_time, body.quality,
                                    body.audio_track, str(body.request_id),
                                    str(body.client_id) if body.client_id else None,
                                    body.capabilities, body.force_transcode, body.max_bitrate)
    except MediaError as exc:
        raise error(exc) from exc


@router.get("/{session_id}")
async def get_session_status(session_id: str, user_id: int = Depends(require_playback_user),
                             after_revision: int | None = Query(default=None, ge=1),
                             wait_ms: int = Query(default=0, ge=0, le=1500)):
    try:
        return await manager.status(user_id, session_id, after_revision, wait_ms)
    except MediaError as exc:
        raise error(exc) from exc


@router.post("/{session_id}/seek", status_code=202)
async def seek_session(session_id: str, body: SeekSession,
                       user_id: int = Depends(require_playback_user)):
    try:
        return await manager.seek(user_id, session_id, body.generation, body.position,
                                  str(body.request_id), client_buffered=body.client_buffered)
    except MediaError as exc:
        raise error(exc) from exc


@router.patch("/{session_id}/options", status_code=202)
async def update_session(session_id: str, body: SessionOptions,
                         user_id: int = Depends(require_playback_user)):
    try:
        return await manager.seek(
            user_id, session_id, body.generation, body.position, str(body.request_id),
            body.quality, body.audio_track, "audio_track" in body.model_fields_set,
            client_buffered=body.client_buffered, capabilities=body.capabilities,
            force_transcode=body.force_transcode, max_bitrate=body.max_bitrate,
            change_max_bitrate="max_bitrate" in body.model_fields_set,
        )
    except MediaError as exc:
        raise error(exc) from exc


@router.post("/{session_id}/heartbeat")
async def heartbeat(session_id: str, body: Heartbeat,
                    user_id: int = Depends(require_playback_user)):
    try:
        return await manager.heartbeat(user_id, session_id, body.generation, body.position,
                                       body.paused, body.playback_rate, body.seek_revision)
    except MediaError as exc:
        raise error(exc) from exc


@router.delete("/{session_id}", status_code=204)
async def delete_session(session_id: str, user_id: int = Depends(require_playback_user)):
    try:
        await manager.close(user_id, session_id)
    except MediaError as exc:
        raise error(exc) from exc
    return Response(status_code=204)


@router.get("/{session_id}/{generation}/index.m3u8")
async def get_playlist(session_id: str, generation: int,
                       user_id: int = Depends(require_playback_user)):
    try:
        text = await manager.playlist(user_id, session_id, generation)
    except MediaError as exc:
        raise error(exc) from exc
    return Response(text, media_type="application/vnd.apple.mpegurl",
                    headers={"Cache-Control": "no-store"})


@router.api_route("/{session_id}/{generation}/stream", methods=["GET", "HEAD"])
async def get_direct_stream(session_id: str, generation: int,
                            user_id: int = Depends(require_playback_user)):
    try:
        media = await manager.open_direct(user_id, session_id, generation)
    except MediaError as exc:
        raise error(exc) from exc
    try:
        return DirectFileResponse(media)
    except BaseException:
        leases.release_source(media.source_id)
        raise


@router.get("/{session_id}/{generation}/segments/{name}")
async def get_segment(session_id: str, generation: int, name: str,
                      user_id: int = Depends(require_playback_user)):
    try:
        segment = await manager.open_segment(user_id, session_id, generation, name)
    except MediaError as exc:
        raise error(exc) from exc

    async def stream():
        with segment.path.open("rb") as source:
            while chunk := await asyncio.to_thread(source.read, 256 * 1024):
                yield chunk

    try:
        return SegmentResponse(segment, stream(), headers={
            "Cache-Control": "no-store", "Content-Length": str(segment.path.stat().st_size),
        })
    except BaseException:
        await asyncio.shield(manager.release_segment(segment))
        raise
