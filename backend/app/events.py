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


def describe_download_error(error: BaseException | str | None) -> str:
    """下载连接异常转为中文，兼容历史日志中保存的异常字符串。"""
    detail = (
        f"{type(error).__name__}: {error}" if isinstance(error, BaseException)
        else str(error or "")
    ).strip()
    if not detail:
        return "未知错误（未记录详细原因）"
    kind, _separator, reason = detail.partition(":")
    if kind == "DownloadDeliveryError":
        return reason.strip()
    message = {
        "ReadError": "读取下载器响应失败，连接可能已中断，请检查下载器状态及网络连接",
        "ConnectError": "无法连接下载器，请检查下载器是否运行、连接地址及端口是否正确",
        "ReadTimeout": "等待下载器响应超时，请检查下载器负载及网络连接",
        "ConnectTimeout": "连接下载器超时，请检查下载器地址、端口及网络连接",
        "WriteTimeout": "向下载器发送请求超时，请检查网络连接",
        "PoolTimeout": "下载器连接繁忙，等待空闲连接超时",
        "WriteError": "向下载器发送请求失败，连接可能已中断",
        "ProxyError": "连接下载器代理失败，请检查代理设置",
        "RemoteProtocolError": "下载器连接意外中断或返回无效响应",
    }.get(kind)
    if kind == "HTTPStatusError" and hasattr(error, "response"):
        return f"下载器接口请求失败（HTTP {error.response.status_code}），请检查下载器状态及配置"
    if message is None:
        return detail
    reason = reason.strip()
    # 常见底层提示由中文说明替代；其他原因保留，避免丢失 TLS 等诊断信息。
    if reason and reason not in {"All connection attempts failed", "Connection reset by peer"}:
        return f"{message}（{kind}；原始原因：{reason}）"
    return f"{message}（{kind}）"


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
        "downloader": "downloader",
        "organize": "organizer",
        "artwork": "scraper",
        "calendar": "calendar",
        "review": "review",
    }.get(event_type.split(".", 1)[0], "system")
    if event_type in {"downloader.test.completed", "downloader.test.failed"}:
        outcome = "成功" if event_type.endswith(".completed") else "失败"
        message = f"下载器连接测试{outcome}：{payload.get('message') or '未记录详细原因'}"
        if payload.get("version"):
            message += f" · {payload['version']}"
    elif event_type == "notification.changed":
        message = payload.get("summary") or "提醒已更新"
    elif event_type.startswith("review."):
        action = {"review.approved": "已批准", "review.ignored": "已忽略",
                  "review.reparsed": "已重新解析"}.get(event_type, "审核已更新")
        message = f"{action}：{payload.get('title', '')}"
    elif event_type == "download.retry.requested":
        message = f"已请求重新下载，等待投递至 qBittorrent：{payload.get('info_hash', '')}"
    elif event_type == "download.failed":
        message = f"下载处理失败：{describe_download_error(payload.get('error'))}"
        if payload.get("retry_seconds"):
            message += (f"；将在 {payload['retry_seconds']} 秒后自动重试，"
                        "连续失败时逐步延长至最多 15 分钟")
    elif event_type == "download.recovered":
        message = f"下载处理已恢复：{payload.get('title', '')}"
    elif event_type == "download.automation.retry.requested":
        message = f"已请求立即重试自动下载：{payload.get('title', '')}"
    elif event_type == "download.superseded":
        message = f"已被更高修订版取代，不再投递：{payload.get('title', '')}"
    elif event_type == "download.upgraded":
        message = f"修订版替换完成，已清理旧任务和旧文件：{payload.get('title', '')}"
    elif event_type == "calendar.fetch.started":
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
    elif event_type == "feed.setup.completed":
        suffix = "，元数据和图片刮削完成" if payload.get("hasTmdb") else ""
        action = {"metadata_refresh": "元数据更新完成", "artwork_scrape": "重新刮削完成"}.get(
            payload.get("kind"), "RSS 订阅已添加",
        )
        message = f"{action}：{payload.get('name', '未知订阅')}{suffix}"
    elif event_type in {"feed.setup.partial", "feed.setup.failed"}:
        result = "刮削不完整" if event_type.endswith(".partial") else "刮削失败"
        message = (
            f"RSS 订阅已保存，{result}：{payload.get('name', '未知订阅')} · "
            f"{payload.get('error') or '详细原因请查看实时日志'}"
        )
    elif event_type == "feed.updated":
        message = f"RSS 订阅已修改：{payload.get('name', '未知订阅')}"
        if payload.get("library_migrations"):
            message += f"，{payload['library_migrations']} 个下载任务等待同步番名和季度"
        elif payload.get("season_migrations"):
            message += f"，{payload['season_migrations']} 个下载任务等待同步季度"
    elif event_type == "download.season.changed":
        message = (f"下载季度已同步：{payload.get('title', '')} · "
                   f"第 {payload.get('previous_season')} 季 → 第 {payload.get('season')} 季")
    elif event_type == "download.episode.renamed":
        message = f"单集已改名：{payload.get('old_name', '')} → {payload.get('filename', '')}"
    elif event_type == "download.library.changed":
        message = (f"媒体库名称和季度已同步：{payload.get('previous_title', '')} "
                   f"S{payload.get('previous_season', 0):02d} → "
                   f"{payload.get('title', '')} S{payload.get('season', 0):02d}")
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
    elif event_type == "library.scan.changed":
        scope = "scraper"
        message = (f"本地图片已同步：{payload.get('name', '')} · "
                   f"{payload.get('thumbnails', 0)} 张单集缩略图")
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
            "sourceId": self.payload.get("source_id") or (
                int(self.resource_id) if self.resource_type == "feed_source" and
                self.resource_id and self.resource_id.isdigit() else None
            ),
            "operationId": self.payload.get("operation_id"),
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


def record_event(session, event_type, resource_type, resource_id, payload):
    """只加入当前事务；广播必须在调用方提交成功之后进行。"""
    from .models import DomainEvent

    event = DomainEvent(
        event_type=event_type, resource_type=resource_type,
        resource_id=str(resource_id) if resource_id is not None else None,
        payload=json.dumps(payload, ensure_ascii=False),
    )
    session.add(event)
    session.info.setdefault("pending_events", []).append(event)
    return event


async def commit_and_publish(session):
    pending = session.info.pop("pending_events", [])
    try:
        await session.commit()
    except BaseException:
        await session.rollback()
        raise
    for event in pending:
        await broker.publish(EventMessage(
            id=event.id, event_type=event.event_type, resource_type=event.resource_type,
            resource_id=event.resource_id, payload=json.loads(event.payload),
            created_at=event.created_at,
        ))


# 回滚时不能把未提交事件带进后续事务。
from sqlalchemy import event as sa_event  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402


@sa_event.listens_for(Session, "after_rollback")
def _discard_pending_events(session):
    session.info.pop("pending_events", None)
