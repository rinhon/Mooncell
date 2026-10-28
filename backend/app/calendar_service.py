"""季度新番日历：源站快照和封面持久化到本地，成功后不重复抓取。"""

import asyncio
import json
import logging
import re
import ssl
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.ext.asyncio import AsyncSession

from .config import settings
from .database import SessionFactory, get_session
from .dependencies import require_user
from .events import EventMessage, _redact, broker
from .models import CalendarFavorite, DomainEvent

router = APIRouter(prefix="/api/v1/calendar", dependencies=[Depends(require_user)])
logger = logging.getLogger(__name__)
CHINA = timezone(timedelta(hours=8))
CALENDAR_CACHE_VERSION = 2
_lock = asyncio.Lock()
_failures: dict[str, datetime] = {}


async def record_calendar_event(event_type: str, season: str, **payload) -> None:
    """先落库再广播；日志异常不能掩盖抓取结果。"""
    payload = {"season": season, **payload}
    if "error" in payload:
        payload["error"] = _redact(payload["error"])
    try:
        async with SessionFactory() as session:
            event = DomainEvent(
                event_type=event_type,
                resource_type="calendar",
                resource_id=season,
                payload=json.dumps(payload, ensure_ascii=False),
            )
            session.add(event)
            await session.commit()
            await broker.publish(
                EventMessage(
                    id=event.id,
                    event_type=event_type,
                    resource_type="calendar",
                    resource_id=season,
                    payload=payload,
                    created_at=event.created_at,
                )
            )
    except Exception:
        logger.exception("日历事件写入或广播失败：%s / %s", event_type, season)


def current_season(now: datetime | None = None) -> str:
    now = now or datetime.now(CHINA)
    return f"{now.year}{((now.month - 1) // 3) * 3 + 1:02d}"


def validate_season(season: str) -> str:
    if not re.fullmatch(r"20\d{2}(01|04|07|10)", season):
        raise ValueError("季度必须是 YYYY01、YYYY04、YYYY07 或 YYYY10")
    if season > current_season():
        raise ValueError("尚未进入该季度")
    return season


def parse_calendar(html: str, season: str) -> list[dict]:
    body = BeautifulSoup(html, "html.parser").select_one(".post-body")
    if body is None:
        raise ValueError("源站缺少新番正文，未保存空数据")
    items = []
    weekday = None
    seen = set()
    for node in body.select(".date2, .div_date, .div_date_"):
        if "date2" in node.get("class", []):
            match = re.search(r"周([一二三四五六日天])", node.get_text())
            weekday = "一二三四五六日".find(match[1].replace("天", "日")) if match else None
            continue
        card = node.parent
        title_node = card.select_one('td[class^="date_title"]')
        if title_node is None:
            title_node = card.select_one("table tr td")
        if title_node is None:
            continue
        title = title_node.get_text(" ", strip=True)
        time_nodes = node.select('p[class^="imgtext"]') or card.select('p[class^="pmfs"]')
        times = dict.fromkeys(
            text for time_node in time_nodes if (text := time_node.get_text(" ", strip=True))
        )
        broadcast = " / ".join(times) or "时间待定"
        item_weekday = None if "div_date_" in node.get("class", []) else weekday
        key = (item_weekday, title, broadcast)
        if not title or key in seen:
            continue
        seen.add(key)
        img = node.select_one("img")
        link = node.select_one("a[href]")
        src = (img.get("data-src") or img.get("src")) if img else None
        src = src or (link.get("href") if link else None)
        cover = urljoin(f"https://yuc.wiki/{season}/", src) if src else None
        items.append(
            {
                "id": len(items) + 1,
                "title": title,
                "weekday": item_weekday,
                "broadcast_time": broadcast,
                "cover_source": cover,
            }
        )
    if not items:
        raise ValueError("源站尚无可解析的新番，未保存空数据")
    return items


def cache_dir() -> Path:
    return Path(settings.calendar_cache_path)


def supplement_other_broadcasts(cached: list[dict], parsed: list[dict]) -> list[dict]:
    """只补齐其他放送，保留原快照及 ID，避免收藏和封面错位。"""
    items = [dict(item) for item in cached]
    existing = {item["title"]: item for item in items if item.get("weekday") is None}
    next_id = max((item["id"] for item in items), default=0) + 1
    for item in parsed:
        if item["weekday"] is not None:
            continue
        previous = existing.get(item["title"])
        if previous is not None:
            if previous.get("broadcast_time") in (None, "", "时间待定"):
                previous["broadcast_time"] = item["broadcast_time"]
            if not previous.get("cover_source"):
                previous["cover_source"] = item["cover_source"]
            continue
        added = {**item, "id": next_id}
        items.append(added)
        existing[item["title"]] = added
        next_id += 1
    return items


def is_certificate_error(exc: BaseException) -> bool:
    while exc is not None:
        if isinstance(exc, ssl.SSLCertVerificationError):
            return True
        exc = exc.__cause__ or exc.__context__
    return False


async def fetch_resource(client: httpx.AsyncClient, url: str, **kwargs) -> httpx.Response:
    """环境代理的证书校验失败时，保留 TLS 校验并尝试直连一次。"""
    try:
        return await client.get(url, **kwargs)
    except httpx.ConnectError as exc:
        if not is_certificate_error(exc):
            raise
        logger.warning("日历请求证书校验失败，尝试通过直连重新获取：%s", url)
        async with httpx.AsyncClient(
            timeout=client.timeout,
            follow_redirects=client.follow_redirects,
            trust_env=False,
        ) as direct:
            return await direct.get(url, **kwargs)


async def download_covers(client: httpx.AsyncClient, season: str, items: list[dict]) -> None:
    semaphore = asyncio.Semaphore(4)
    errors = []

    async def download(item: dict) -> None:
        path = cache_dir() / season / f"{item['id']}.img"
        if path.exists() or not item.get("cover_source"):
            return
        url = item["cover_source"]
        parsed_url = urlparse(url)
        host = parsed_url.hostname or ""
        trusted = host in {"yuc.wiki", "i.imgs.ovh"} or host.endswith(".hdslb.com")
        if trusted and parsed_url.scheme == "http":
            url = parsed_url._replace(scheme="https").geturl()
        if not trusted or urlparse(url).scheme != "https":
            errors.append(f"{item['title']}：不支持的封面地址")
            return
        async with semaphore:
            try:
                response = await fetch_resource(client, url, follow_redirects=False)
                response.raise_for_status()
                if not response.headers.get("content-type", "").startswith("image/"):
                    raise ValueError("源站返回的内容不是图片")
                temporary = path.with_suffix(".tmp")
                await asyncio.to_thread(temporary.write_bytes, response.content)
                temporary.replace(path)
            except (httpx.HTTPError, OSError, ValueError) as exc:
                errors.append(f"{item['title']}：{type(exc).__name__}: {exc}")
                logger.warning("日历封面下载失败：%s / %s", season, item["id"])

    await asyncio.gather(*(download(item) for item in items))
    if errors:
        await record_calendar_event(
            "calendar.covers.partial",
            season,
            count=len(errors),
            error="；".join(errors),
        )


async def ensure_season(season: str) -> dict:
    validate_season(season)
    async with _lock:
        path = cache_dir() / season / "season.json"
        cached = None
        if path.exists():
            cached = json.loads(await asyncio.to_thread(path.read_text, encoding="utf-8"))
            if cached.get("cache_version", 0) >= CALENDAR_CACHE_VERSION:
                return cached
        failed_at = _failures.get(season)
        if failed_at and datetime.now(UTC) - failed_at < timedelta(minutes=15):
            if cached is not None:
                return cached
            raise ValueError("当季获取暂时失败，15 分钟后自动重试")
        try:
            await record_calendar_event("calendar.fetch.started", season)
            async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
                response = await fetch_resource(client, f"https://yuc.wiki/{season}/")
                response.raise_for_status()
                items = parse_calendar(response.text, season)
                if cached is not None:
                    items = supplement_other_broadcasts(cached["items"], items)
                path.parent.mkdir(parents=True, exist_ok=True)
                await download_covers(client, season, items)
                data = {
                    **(cached or {}),
                    "season": season,
                    "source_url": f"https://yuc.wiki/{season}/",
                    "fetched_at": cached["fetched_at"] if cached else datetime.now(UTC).isoformat(),
                    "cache_version": CALENDAR_CACHE_VERSION,
                    "items": items,
                }
                temporary = path.with_suffix(".tmp")
                await asyncio.to_thread(
                    temporary.write_text, json.dumps(data, ensure_ascii=False), encoding="utf-8"
                )
                temporary.replace(path)
                _failures.pop(season, None)
                await record_calendar_event("calendar.fetch.completed", season, count=len(items))
                return data
        except (httpx.HTTPError, ValueError, OSError) as exc:
            _failures[season] = datetime.now(UTC)
            await record_calendar_event(
                "calendar.fetch.failed",
                season,
                error=f"{type(exc).__name__}: {exc}",
            )
            if cached is not None:
                return cached
            raise


async def calendar_refresh_loop() -> None:
    while True:
        try:
            season = current_season()
            was_cached = (cache_dir() / season / "season.json").exists()
            data = await ensure_season(season)
            # 元数据只抓一次；暂时失败的封面可独立补全。
            if was_cached:
                async with httpx.AsyncClient(timeout=30) as client:
                    await download_covers(client, season, data["items"])
        except Exception:
            logger.exception("季度新番获取失败，将自动重试")
        now = datetime.now(CHINA)
        month = ((now.month - 1) // 3) * 3 + 4
        boundary = datetime(now.year + (month > 12), 1 if month > 12 else month, 1, tzinfo=CHINA)
        await asyncio.sleep(min(900, max(1, (boundary - now).total_seconds())))


@router.get("")
async def read_calendar(season: str | None = None, session: AsyncSession = Depends(get_session)):
    season = season or current_season()
    try:
        validate_season(season)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    try:
        data = await ensure_season(season)
    except (httpx.HTTPError, ValueError, OSError) as exc:
        if is_certificate_error(exc):
            raise HTTPException(
                503,
                "日历源站 HTTPS 证书校验失败，直连重试也未成功。"
                "请检查系统时间和代理证书；15 分钟后自动重试，重启后端可立即重试。",
            ) from exc
        raise HTTPException(503, "季度新番暂时获取失败，稍后自动重试。") from exc
    favorites = set(
        await session.scalars(
            select(CalendarFavorite.item_id).where(
                CalendarFavorite.season == season,
            )
        )
    )
    return {
        **data,
        "current_season": current_season(),
        "items": [
            {
                **item,
                "liked": item["id"] in favorites,
                "cover_url": f"/api/v1/calendar/{season}/covers/{item['id']}"
                if (cache_dir() / season / f"{item['id']}.img").exists()
                else None,
            }
            for item in data["items"]
        ],
    }


class FavoriteUpdate(BaseModel):
    liked: bool


@router.put("/{season}/items/{item_id}/favorite")
async def set_favorite(
    season: str,
    item_id: int,
    data: FavoriteUpdate,
    session: AsyncSession = Depends(get_session),
):
    try:
        validate_season(season)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    path = cache_dir() / season / "season.json"
    if not path.is_file():
        raise HTTPException(404, "季度日历尚未缓存")
    calendar = json.loads(await asyncio.to_thread(path.read_text, encoding="utf-8"))
    if not any(item["id"] == item_id for item in calendar["items"]):
        raise HTTPException(404, "番剧不存在")
    if data.liked:
        await session.execute(
            insert(CalendarFavorite)
            .values(
                season=season,
                item_id=item_id,
            )
            .on_conflict_do_nothing()
        )
    else:
        await session.execute(
            delete(CalendarFavorite).where(
                CalendarFavorite.season == season,
                CalendarFavorite.item_id == item_id,
            )
        )
    await session.commit()
    return {"season": season, "id": item_id, "liked": data.liked}


@router.get("/{season}/covers/{item_id}")
async def read_cover(season: str, item_id: int):
    try:
        validate_season(season)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    path = cache_dir() / season / f"{item_id}.img"
    if not path.is_file():
        raise HTTPException(404, "封面尚未缓存")
    return FileResponse(path, headers={"Cache-Control": "private, max-age=31536000"})
