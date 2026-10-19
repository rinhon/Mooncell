"""RSS/Atom 拉取、条件请求、条目去重和标题解析编排。"""

import asyncio
import calendar
import hashlib
import json
import re
import socket
import ssl
from datetime import UTC, datetime
from typing import Any

import feedparser
import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import settings
from .database import SessionFactory
from .downloader_service import extract_info_hash
from .events import EventMessage, broker
from .models import DomainEvent, FeedItem, FeedSource
from .providers.mikan import is_mikan_feed, normalize_mikan_channel_title
from .release_parser import parse_release_title
from .schemas import FeedInspectResult, FeedRefreshResult
from .subscription_settings import get_options


def _entry_value(entry: Any, name: str, default=None):
    if isinstance(entry, dict):
        return entry.get(name, default)
    return getattr(entry, name, default)


def _published_at(entry: Any) -> datetime | None:
    """把 feedparser 的 UTC time tuple 转为带时区的 datetime。"""
    parsed = _entry_value(entry, "published_parsed") or _entry_value(entry, "updated_parsed")
    if not parsed:
        return None
    return datetime.fromtimestamp(calendar.timegm(parsed), tz=UTC)


def _download_url(entry: Any) -> str | None:
    """兼容 Mikan enclosure、BT MIME、torrent 文件和 magnet 链接。"""
    links = _entry_value(entry, "links", []) or []
    for link in links:
        href = _entry_value(link, "href")
        media_type = (_entry_value(link, "type", "") or "").lower()
        relation = (_entry_value(link, "rel", "") or "").lower()
        if href and (
            href.startswith("magnet:")
            or "bittorrent" in media_type
            or relation == "enclosure"
            or href.lower().endswith(".torrent")
        ):
            return href
    link = _entry_value(entry, "link")
    return link if isinstance(link, str) and link.startswith("magnet:") else None


def parse_feed_metadata(content: bytes, source_url: str) -> FeedInspectResult:
    """读取频道标题，并按站点适配器生成默认订阅名称。"""
    parsed = feedparser.parse(content)
    raw_title = str(_entry_value(parsed.feed, "title", "")).strip()
    if parsed.bozo and not raw_title:
        raise ValueError(f"RSS 解析失败：{parsed.bozo_exception}")
    if not raw_title:
        raise ValueError("RSS 缺少频道标题 <channel><title>")
    mikan = is_mikan_feed(source_url, raw_title)
    name = normalize_mikan_channel_title(raw_title) if mikan else raw_title
    return FeedInspectResult(
        raw_title=raw_title,
        name=name,
        kind="mikan" if mikan else "standard",
        entries=len(parsed.entries),
    )


def describe_rss_exception(exc: Exception) -> str:
    """统一生成中文网络错误说明，保留异常类型及 TLS 错误码供排查。"""
    kind = type(exc).__name__
    if isinstance(exc, httpx.TimeoutException):
        return f"RSS 请求超时（{settings.rss_timeout_seconds:g} 秒；{kind}）"

    # HTTPX 会包装底层 SSL/DNS 异常，逐层检查以保留准确的失败原因。
    causes: list[BaseException] = []
    cause: BaseException | None = exc
    seen: set[int] = set()
    while cause is not None and id(cause) not in seen:
        seen.add(id(cause))
        causes.append(cause)
        cause = cause.__cause__ or cause.__context__
    details = " ".join(str(error) for error in causes).upper()
    tls_error = next((error for error in reversed(causes) if isinstance(error, ssl.SSLError)), None)
    code_match = re.search(r"\[SSL:\s*([A-Z0-9_]+)\]", details)
    tls_code = getattr(tls_error, "reason", None) or (code_match[1] if code_match else None)
    if not tls_code:
        tls_code = next((code for code in (
            "CERTIFICATE_VERIFY_FAILED", "TLSV1_ALERT_INTERNAL_ERROR",
            "UNEXPECTED_EOF_WHILE_READING", "WRONG_VERSION_NUMBER",
        ) if code in details), None)

    message = None
    if tls_error is not None or isinstance(exc, httpx.TransportError):
        is_tls = tls_error is not None or tls_code or "TLS" in details or "SSL" in details
        if isinstance(tls_error, ssl.SSLCertVerificationError) or (
            tls_code == "CERTIFICATE_VERIFY_FAILED"
        ):
            message = "HTTPS 证书校验失败，请检查源站证书或代理证书配置"
        elif tls_code == "TLSV1_ALERT_INTERNAL_ERROR":
            message = (
                "HTTPS 安全连接建立失败：源站或代理返回 TLS 内部错误，"
                "请检查订阅代理及源站连接状态"
            )
        elif tls_code == "WRONG_VERSION_NUMBER":
            message = "HTTPS 协议协商失败，请检查源站 TLS 配置及代理地址的协议和端口"
        elif is_tls and ("EOF" in details or isinstance(tls_error, ssl.SSLEOFError)):
            message = "HTTPS 安全连接被提前关闭，请检查源站或代理连接并稍后重试"
        elif is_tls:
            message = "HTTPS 安全连接失败，请检查源站或代理的 TLS 配置与连接状态"
        elif isinstance(exc, httpx.ProxyError):
            message = "订阅代理连接失败，请检查代理地址、端口及代理服务状态"
        elif any(isinstance(error, socket.gaierror) for error in causes) or any(
            marker in details for marker in ("GETADDRINFO FAILED", "NAME OR SERVICE NOT KNOWN")
        ):
            message = "源站或代理的域名解析失败，请检查地址及 DNS 设置"
        elif isinstance(exc, httpx.ConnectError):
            message = "无法连接 RSS 源站或代理，请检查网络连接、地址和端口"
        elif isinstance(exc, (httpx.ReadError, httpx.WriteError, httpx.RemoteProtocolError)):
            message = "RSS 数据传输中断，请检查源站或代理连接并稍后重试"
        else:
            message = "RSS 网络请求失败，请检查网络或代理连接"
    elif isinstance(exc, httpx.HTTPStatusError):
        message = f"RSS 源站返回 HTTP {exc.response.status_code}，请检查访问权限或源站状态"
    if message:
        return f"{message}（{kind}{f'；{tls_code}' if tls_code else ''}）"

    detail = str(exc).strip()
    return f"{kind}: {detail}" if detail else kind


async def _get_with_retry(client: httpx.AsyncClient, source_url: str) -> httpx.Response:
    """Mikan 镜像偶发提前关闭 TLS 连接，传输错误允许一次短重试。"""
    for attempt in range(2):
        try:
            return await client.get(source_url)
        except httpx.TransportError:
            if attempt == 1:
                raise
            await asyncio.sleep(0.4)
    raise RuntimeError("RSS 请求重试流程异常结束")


async def inspect_feed(source_url: str) -> FeedInspectResult:
    """请求 RSS 并返回创建订阅所需的频道级预览。"""
    async with SessionFactory() as session:
        options = await get_options(session)
    async with httpx.AsyncClient(
        proxy=str(options.proxy_url) if options.proxy_url else None,
        trust_env=False,
        timeout=settings.rss_timeout_seconds,
        follow_redirects=True,
        headers={"User-Agent": settings.rss_user_agent},
    ) as client:
        response = await _get_with_retry(client, source_url)
        response.raise_for_status()
    return await asyncio.to_thread(parse_feed_metadata, response.content, source_url)


async def _store_event(
    session: AsyncSession,
    event_type: str,
    resource_type: str | None,
    resource_id: str | None,
    payload: dict,
) -> DomainEvent:
    """先持久化事件，保证浏览器断线重连后仍可补发。"""
    event = DomainEvent(
        event_type=event_type,
        resource_type=resource_type,
        resource_id=resource_id,
        payload=json.dumps(payload, ensure_ascii=False),
    )
    session.add(event)
    await session.flush()
    return event


async def _publish_event(event: DomainEvent) -> None:
    """把已获得数据库 ID 的事件广播给当前在线客户端。"""
    await broker.publish(
        EventMessage(
            id=event.id,
            event_type=event.event_type,
            resource_type=event.resource_type,
            resource_id=event.resource_id,
            payload=json.loads(event.payload),
            created_at=event.created_at,
        )
    )


class FeedRefreshService:
    """一次 RSS 刷新的完整事务边界。"""

    def __init__(self, session: AsyncSession):
        self.session = session

    async def refresh(self, source: FeedSource) -> FeedRefreshResult:
        """拉取订阅源，幂等保存新条目，并发布刷新事件。"""
        if source.kind == "magnet":
            raise ValueError("磁力合集是单次下载，无需刷新 RSS")
        headers = {"User-Agent": settings.rss_user_agent}
        # ETag/Last-Modified 让频繁轮询在没有更新时几乎不消耗流量。
        if source.etag:
            headers["If-None-Match"] = source.etag
        if source.last_modified:
            headers["If-Modified-Since"] = source.last_modified

        started = await _store_event(
            self.session,
            "feed.refresh.started",
            "feed_source",
            str(source.id),
            {"name": source.name},
        )
        await self.session.commit()
        await _publish_event(started)

        try:
            options = await get_options(self.session)
            # 结束设置查询开启的事务，网络等待和解析期间归还数据库连接。
            source_url = source.url
            await self.session.commit()
            async with httpx.AsyncClient(
                proxy=str(options.proxy_url) if options.proxy_url else None,
                trust_env=False,
                timeout=settings.rss_timeout_seconds,
                follow_redirects=True,
                headers=headers,
            ) as client:
                response = await _get_with_retry(client, source_url)

            if response.status_code == 304:
                await self._enqueue_downloads(source)
                source.last_checked_at = datetime.now(UTC)
                source.connection_status = "healthy"
                source.last_error = None
                completed = await _store_event(
                    self.session,
                    "feed.refresh.completed",
                    "feed_source",
                    str(source.id),
                    {"created": 0, "notModified": True},
                )
                await self.session.commit()
                await _publish_event(completed)
                return FeedRefreshResult(
                    source_id=source.id, fetched=0, created=0, duplicates=0, not_modified=True
                )

            response.raise_for_status()
            # Mikan 提供标准 RSS，因此先走通用解析器；专用适配器可在此分流。
            parsed = await asyncio.to_thread(feedparser.parse, response.content)
            if parsed.bozo and not parsed.entries:
                raise ValueError(f"RSS 解析失败：{parsed.bozo_exception}")

            source.last_checked_at = datetime.now(UTC)
            source.etag = response.headers.get("etag")
            source.last_modified = response.headers.get("last-modified")
            source.connection_status = "healthy"
            source.last_error = None

            created = 0
            duplicates = 0
            excluded_keywords = [
                value.casefold() for value in source.excluded_keywords or [] if value
            ]
            fingerprints = set(await self.session.scalars(
                select(FeedItem.fingerprint).where(FeedItem.source_id == source.id)
            ))
            for entry in parsed.entries:
                title = str(_entry_value(entry, "title", "")).strip()
                if not title:
                    continue
                if any(keyword in title.casefold() for keyword in excluded_keywords):
                    continue
                guid = _entry_value(entry, "id") or _entry_value(entry, "guid")
                detail_url = _entry_value(entry, "link")
                download_url = _download_url(entry)
                # GUID 并非所有源都稳定，组合关键字段生成本站内去重指纹。
                identity = "|".join(
                    [str(source.id), str(guid or ""), str(download_url or detail_url or ""), title]
                )
                fingerprint = hashlib.sha256(identity.encode("utf-8")).hexdigest()
                if fingerprint in fingerprints:
                    duplicates += 1
                    continue
                release = parse_release_title(title)
                if source.season is not None:
                    release.season = source.season
                # 低置信度或带警告的结果保留人工审核。
                self.session.add(
                    FeedItem(
                        source_id=source.id,
                        guid=str(guid) if guid else None,
                        title=title,
                        detail_url=str(detail_url) if detail_url else None,
                        download_url=download_url,
                        info_hash=extract_info_hash(download_url),
                        published_at=_published_at(entry),
                        fingerprint=fingerprint,
                        parse_status=(
                            "needs_review"
                            if release.confidence < 0.9 or release.warnings
                            else "parsed"
                        ),
                        parse_data=release.model_dump_json(),
                    )
                )
                created += 1
                fingerprints.add(fingerprint)

            await self.session.flush()
            await self._enqueue_downloads(source)
            completed = await _store_event(
                self.session,
                "feed.refresh.completed",
                "feed_source",
                str(source.id),
                {"fetched": len(parsed.entries), "created": created, "duplicates": duplicates},
            )
            await self.session.commit()
            await _publish_event(completed)
            return FeedRefreshResult(
                source_id=source.id,
                fetched=len(parsed.entries),
                created=created,
                duplicates=duplicates,
            )
        except Exception as exc:
            source.connection_status = "error"
            source.last_checked_at = datetime.now(UTC)
            source.last_error = describe_rss_exception(exc)[:1000]
            failed = await _store_event(
                self.session,
                "feed.refresh.failed",
                "feed_source",
                str(source.id),
                {"error": source.last_error},
            )
            await self.session.commit()
            await _publish_event(failed)
            raise

    async def _enqueue_downloads(self, source: FeedSource) -> None:
        from .download_queue import enqueue_source, queue_lock

        # 先释放 RSS 入库事务，避免持有 SQLite 写锁等待下载队列。
        await self.session.commit()
        try:
            async with queue_lock:
                async with self.session.begin_nested():
                    await enqueue_source(self.session, source)
                await self.session.commit()
        except Exception as exc:
            from .events import _redact, describe_download_error

            await _store_event(self.session, "download.failed", "feed_source", str(source.id),
                               {"error": _redact(describe_download_error(exc))})
