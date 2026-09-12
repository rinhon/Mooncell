"""RSS/Atom 拉取、条件请求、条目去重和标题解析编排。"""

import asyncio
import calendar
import hashlib
import json
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
    """保证日志和 HTTP 响应始终包含可诊断的异常类型与说明。"""
    if isinstance(exc, httpx.TimeoutException):
        return (
            f"{exc.__class__.__name__}: RSS 请求超时"
            f"（{settings.rss_timeout_seconds:g} 秒）"
        )
    detail = str(exc).strip()
    return f"{exc.__class__.__name__}: {detail}" if detail else exc.__class__.__name__


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
            excluded_keywords = [value.casefold() for value in source.excluded_keywords or [] if value]
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
        from .download_queue import enqueue_source

        try:
            async with self.session.begin_nested():
                await enqueue_source(self.session, source)
        except Exception as exc:
            from .events import _redact

            await _store_event(self.session, "download.failed", "feed_source", str(source.id),
                               {"error": _redact(describe_rss_exception(exc))})
