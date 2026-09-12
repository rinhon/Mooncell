"""轻量级进程内事件总线，为 WebUI 提供 SSE 实时更新。"""

import asyncio
import json
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime

_SENSITIVE_VALUE = re.compile(
    r"(?i)(password|passwd|secret|token|api[_-]?key)(\s*[=:]\s*)([^\s,;]+)"
)
_URL_CREDENTIALS = re.compile(r"(https?://)([^/@:\s]+):([^/@\s]+)@", re.IGNORECASE)


def _redact(message: str) -> str:
    """在日志进入浏览器前隐藏常见密钥字段和 URL 凭据。"""
    message = _URL_CREDENTIALS.sub(r"\1***:***@", message)
    return _SENSITIVE_VALUE.sub(r"\1\2***", message)


def event_log_fields(event_type: str, payload: dict) -> tuple[str, str, str]:
    """把领域事件转换成适合实时日志页面展示的级别、范围和消息。"""
    level = (
        "error"
        if event_type.endswith(".failed")
        else "warning"
        if event_type.endswith(".partial")
        else "info"
    )
    scope = {
        "feed": "rss",
        "item": "parser",
        "download": "downloader",
        "organize": "organizer",
        "artwork": "scraper",
        "calendar": "calendar",
    }.get(event_type.split(".", 1)[0], "system")
    if event_type == "calendar.fetch.started":
        message = f"开始获取季度新番：{payload.get('season', '')}"
    elif event_type == "calendar.fetch.completed":
        message = f"季度新番已保存：{payload.get('season', '')} · {payload.get('count', 0)} 条"
    elif event_type == "calendar.fetch.failed":
        message = (
            f"季度新番获取失败：{payload.get('season', '')} · "
            f"{payload.get('error') or '未知错误'} · 15 分钟后可重试"
        )
    elif event_type == "calendar.covers.partial":
        message = (
            f"季度新番封面缓存不完整：{payload.get('season', '')} · "
            f"{payload.get('count', 0)} 张失败 · {payload.get('error') or '未知错误'}"
        )
    elif event_type == "feed.refresh.started":
        message = f"开始刷新 RSS：{payload.get('name', '未知订阅')}"
    elif event_type == "feed.refresh.completed":
        if payload.get("notModified"):
            message = "RSS 未发生变化"
        else:
            message = (
                f"RSS 刷新完成：读取 {payload.get('fetched', 0)} 条，"
                f"新增 {payload.get('created', 0)} 条，"
                f"重复 {payload.get('duplicates', 0)} 条"
            )
    elif event_type == "feed.refresh.failed":
        error = payload.get("error") or "未知错误（旧日志未记录异常类型）"
        message = f"RSS 刷新失败：{error}"
    elif event_type == "artwork.upload.completed":
        message = f"番剧图片上传成功：{payload.get('name', '')} · {payload.get('kind', '')}"
    elif event_type == "artwork.upload.failed":
        message = (
            f"番剧图片上传失败：{payload.get('name', '')} · {payload.get('kind', '')} · "
            f"{payload.get('error') or '未知错误'}"
        )
    elif event_type == "artwork.scrape.started":
        message = f"开始刮削番剧图片：{payload.get('name', '未知番剧')}"
    elif event_type == "artwork.scrape.completed":
        message = f"番剧图片刮削完成：{payload.get('name', '未知番剧')}（三图已就绪）"
    elif event_type == "artwork.scrape.partial":
        error = payload.get("error") or "TMDB 返回的图片不完整"
        message = f"番剧图片刮削不完整：{payload.get('name', '未知番剧')} · {error}"
    elif event_type == "artwork.scrape.failed":
        error = payload.get("error") or "未知错误"
        message = f"番剧图片刮削失败：{payload.get('name', '未知番剧')} · {error}"
    else:
        message = f"{event_type} · {json.dumps(payload, ensure_ascii=False)}"
    return level, scope, _redact(message)


@dataclass(slots=True)
class EventMessage:
    """前后端共用的领域事件传输结构。"""

    id: int
    event_type: str
    resource_type: str | None
    resource_id: str | None
    payload: dict
    created_at: datetime

    def as_sse(self, event_name: str | None = None) -> str:
        """编码为浏览器 EventSource 能识别的 SSE 文本帧。"""
        level, scope, message = event_log_fields(self.event_type, self.payload)
        data = {
            "id": self.id,
            "type": self.event_type,
            "resourceType": self.resource_type,
            "resourceId": self.resource_id,
            "payload": self.payload,
            "occurredAt": self.created_at.isoformat(),
            "level": level,
            "scope": scope,
            "message": message,
        }
        encoded = json.dumps(data, ensure_ascii=False)
        return f"id: {self.id}\nevent: {event_name or self.event_type}\ndata: {encoded}\n\n"


class EventBroker:
    """向当前进程内所有在线 WebUI 广播事件。"""

    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[EventMessage]] = set()

    async def publish(self, message: EventMessage) -> None:
        # 满队列通常意味着客户端已卡死；丢弃该订阅者以免阻塞 RSS 主流程。
        stale: list[asyncio.Queue[EventMessage]] = []
        for queue in self._subscribers:
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                stale.append(queue)
        for queue in stale:
            self._subscribers.discard(queue)

    @asynccontextmanager
    async def subscribe(self) -> AsyncIterator[asyncio.Queue[EventMessage]]:
        """在上下文退出时可靠移除订阅者，防止队列泄漏。"""
        queue: asyncio.Queue[EventMessage] = asyncio.Queue(maxsize=128)
        self._subscribers.add(queue)
        try:
            yield queue
        finally:
            self._subscribers.discard(queue)


broker = EventBroker()
