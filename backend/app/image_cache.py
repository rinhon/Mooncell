"""认证图片接口共用的文件版本、条件请求和浏览器缓存策略。"""

import os
import stat
from dataclasses import dataclass
from datetime import UTC
from email.utils import parsedate_to_datetime
from pathlib import Path

from fastapi import Request, Response
from fastapi.responses import FileResponse

from .library_scan import ImageFile


@dataclass(frozen=True)
class ImageState:
    stat: os.stat_result
    version: str


def image_state(path: Path, version_path: str | None = None) -> ImageState:
    """共用一次 stat 生成 URL 版本和响应头，避免两次读取拼出不同的文件状态。"""
    result = path.stat()
    if not stat.S_ISREG(result.st_mode):
        raise FileNotFoundError(str(path))
    image = ImageFile(version_path if version_path is not None else str(path),
                      result.st_mtime_ns, result.st_size)
    return ImageState(result, image.version)


def cached_image_response(
    request: Request, path: Path, version_path: str | None = None,
) -> Response:
    state = image_state(path, version_path)
    # URL 仍会读取当前文件，因此旧版本请求不能把新内容再次长期缓存。
    cache_control = (
        "private, max-age=31536000"
        if request.query_params.get("v") == state.version else "private, no-cache"
    )
    response = FileResponse(
        path, stat_result=state.stat,
        headers={"Cache-Control": cache_control, "ETag": f'W/"{state.version}"'},
    )
    if_none_match = request.headers.get("if-none-match")
    if if_none_match is not None:
        # GET/HEAD 使用弱比较；If-None-Match 一旦出现，便优先于日期校验。
        etag = response.headers["etag"].removeprefix("W/")
        unchanged = any(
            value.strip() == "*" or value.strip().removeprefix("W/") == etag
            for value in if_none_match.split(",")
        )
    else:
        unchanged = False
        if_modified_since = request.headers.get("if-modified-since")
        if if_modified_since:
            try:
                since = parsedate_to_datetime(if_modified_since)
                if since.tzinfo is None:
                    since = since.replace(tzinfo=UTC)
                unchanged = int(state.stat.st_mtime) <= since.timestamp()
            except (TypeError, ValueError, OverflowError):
                pass
    if unchanged:
        return Response(status_code=304, headers={
            name: response.headers[name] for name in ("cache-control", "etag", "last-modified")
        })
    return response
