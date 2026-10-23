"""带读取租约的原文件 Range 响应，复用 Starlette 的 HTTP 边界处理。"""

import asyncio

from starlette.responses import FileResponse
from starlette.types import Receive, Scope, Send

from . import leases
from .media import ResolvedMedia, ensure_current


class DirectFileResponse(FileResponse):
    """调用者先登记一次响应租约；包括 HEAD/416/发送失败均在此释放。"""

    def __init__(self, media: ResolvedMedia):
        self.media = media
        super().__init__(media.path, media_type="video/mp4", headers={
            "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
            "ETag": f'"{media.version}"',
        })

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await asyncio.to_thread(ensure_current, self.media)
            await super().__call__(scope, receive, send)
        finally:
            leases.release_source(self.media.source_id)
