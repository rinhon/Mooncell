"""探测持久化与有界后台预热；扫描只入队，不等待媒体工具。"""

import asyncio
import contextlib
import logging
import time

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import SessionFactory
from ..models import MediaFile
from . import probe
from .media import MediaError, ResolvedMedia, resolve_media
from .schemas import PlaybackInfo

logger = logging.getLogger(__name__)


async def persist_probe(database: AsyncSession, media: ResolvedMedia, info: PlaybackInfo) -> None:
    persisted = info.model_copy(deep=True)
    persisted.subtitle_tracks = [track for track in persisted.subtitle_tracks
                                if track.id.startswith("s:")]
    persisted.progress = None
    payload = persisted.model_dump_json()
    if media.probe_json == payload:
        return
    await database.execute(update(MediaFile).where(
        MediaFile.id == media.media_id, MediaFile.file_version == media.version,
    ).values(probe_json=payload))
    await database.commit()
    await database.close()


class ProbePrewarmer:
    def __init__(self):
        self.queue: asyncio.Queue[str] = asyncio.Queue(maxsize=32)
        self.pending: set[str] = set()
        self.finished: dict[str, float] = {}
        self.task: asyncio.Task | None = None

    def start(self) -> None:
        if self.task is None or self.task.done():
            self.task = asyncio.create_task(self._run(), name="playback-probe-prewarm")

    def schedule(self, media_ids: list[str]) -> None:
        if self.task is None or self.task.done():
            return
        now = time.monotonic()
        for media_id in media_ids:
            if media_id in self.pending or now - self.finished.get(media_id, -3600) < 60:
                continue
            try:
                self.queue.put_nowait(media_id)
            except asyncio.QueueFull:
                break
            self.pending.add(media_id)

    async def shutdown(self) -> None:
        if self.task:
            self.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.task
            self.task = None
        while not self.queue.empty():
            self.queue.get_nowait()
            self.queue.task_done()
        self.pending.clear()

    async def _run(self) -> None:
        while True:
            media_id = await self.queue.get()
            try:
                # 单个预热 worker，并为前台探测保留另一个工具名额。
                await asyncio.sleep(0.1)
                while probe._inflight:
                    await asyncio.sleep(0.1)
                async with SessionFactory() as database:
                    media = await resolve_media(database, media_id)
                    await database.close()
                    info = await probe.probe_media(media)
                    await persist_probe(database, media, info)
            except MediaError:
                pass  # 文件替换/迁移/探测失败不影响列表；一分钟后可重试。
            except Exception:
                logger.exception("媒体后台预探测失败")
            finally:
                self.pending.discard(media_id)
                self.finished[media_id] = time.monotonic()
                if len(self.finished) > 512:
                    self.finished.pop(next(iter(self.finished)))
                self.queue.task_done()


prewarmer = ProbePrewarmer()
