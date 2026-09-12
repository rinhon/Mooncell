"""无需 API Key 的 TMDB HTML 搜索与详情页刮削适配器。"""

import asyncio
import json
import re
import time
from dataclasses import dataclass
from typing import Literal
from urllib.parse import urlencode, urljoin

import httpx
from bs4 import BeautifulSoup

from ..config import settings
from ..schemas import TmdbCandidate, TmdbMetadata

MediaType = Literal["tv", "movie"]
_DETAIL_PATH = re.compile(r"^/(tv|movie)/(\d+)(?:-|\?|$)")


@dataclass(slots=True)
class TmdbArtworkUrls:
    poster: str | None
    fanart: str | None
    clearlogo: str | None


def parse_tmdb_image_page(content: str) -> str | None:
    """从 TMDB 图片列表选择第一张原图链接。"""
    soup = BeautifulSoup(content, "html.parser")
    anchor = soup.select_one('ul.images a[href*="image.tmdb.org/t/p/original/"]')
    return str(anchor.get("href")) if anchor and anchor.get("href") else None


def parse_tmdb_search_html(content: str) -> list[TmdbCandidate]:
    """从 TMDB 搜索结果的媒体卡片中提取候选项。"""
    soup = BeautifulSoup(content, "html.parser")
    candidates: list[TmdbCandidate] = []
    seen: set[tuple[str, int]] = set()

    for card in soup.select("div.media-card-list > div"):
        anchor = card.find("a", href=_DETAIL_PATH)
        if anchor is None:
            continue
        href = str(anchor.get("href", ""))
        match = _DETAIL_PATH.match(href)
        if match is None:
            continue
        media_type, raw_id = match.groups()
        key = (media_type, int(raw_id))
        if key in seen:
            continue
        seen.add(key)

        heading = card.find("h2")
        if heading is None:
            continue
        title_parts = [part.get_text(" ", strip=True) for part in heading.find_all("span")]
        title = title_parts[0] if title_parts else heading.get_text(" ", strip=True)
        original_title = None
        if len(title_parts) > 1:
            original_title = title_parts[1].strip().removeprefix("(").removesuffix(")") or None
        date_node = card.select_one(".release_date")
        overview_node = card.select_one(".mt-4 p")
        poster_node = card.select_one("img.poster")
        candidates.append(
            TmdbCandidate(
                tmdb_id=key[1],
                media_type=media_type,
                title=title,
                original_title=original_title,
                release_date=date_node.get_text(" ", strip=True) if date_node else None,
                overview=overview_node.get_text(" ", strip=True) if overview_node else None,
                poster_url=str(poster_node.get("src"))
                if poster_node and poster_node.get("src")
                else None,
                href=urljoin(settings.tmdb_base_url, href),
            )
        )
    return candidates


def parse_tmdb_detail_html(content: str, tmdb_id: int, media_type: MediaType) -> TmdbMetadata:
    """详情页优先读取 TMDB 自带的 JSON-LD，减少对展示层级的依赖。"""
    soup = BeautifulSoup(content, "html.parser")
    script = soup.find("script", attrs={"type": "application/ld+json"})
    if script is None:
        raise ValueError("TMDB 详情页缺少 JSON-LD 元数据")
    raw_json = script.get_text().replace("/* <![CDATA[ */", "").replace("/* ]]> */", "").strip()
    data = json.loads(raw_json)
    start_date = data.get("startDate") or data.get("datePublished")
    rating = data.get("aggregateRating") or {}
    genres = data.get("genre") or []
    if isinstance(genres, str):
        genres = [genres]
    return TmdbMetadata(
        tmdb_id=tmdb_id,
        media_type=media_type,
        title=str(data.get("name") or "").strip(),
        overview=str(data.get("description") or "").strip() or None,
        poster_url=data.get("image"),
        release_date=str(start_date)[:10] if start_date else None,
        genres=[str(item) for item in genres],
        episode_count=data.get("numberOfEpisodes"),
        rating=rating.get("ratingValue"),
        vote_count=rating.get("ratingCount"),
        href=str(data.get("url") or f"{settings.tmdb_base_url}/{media_type}/{tmdb_id}"),
    )


def _get_html_sync(url: str) -> str:
    """使用同步传输获取页面，规避 Windows 上 AsyncClient 的偶发 TLS 握手失败。"""
    headers = {"User-Agent": settings.tmdb_user_agent, "Accept-Language": settings.tmdb_language}
    for attempt in range(8):
        # 每次重试都重建连接池，避免继续复用已被中间代理关闭的 TLS 连接。
        with httpx.Client(
            timeout=settings.tmdb_timeout_seconds,
            follow_redirects=True,
            headers=headers,
        ) as client:
            try:
                response = client.get(url)
                response.raise_for_status()
                return response.text
            except httpx.TransportError:
                if attempt == 7:
                    raise
        time.sleep(min(0.35 * (2**attempt), 1.5))
    raise RuntimeError("TMDB 请求失败")


async def _get_html(url: str) -> str:
    """在线程中执行同步 TLS 请求，避免阻塞 FastAPI 的事件循环。"""
    return await asyncio.to_thread(_get_html_sync, url)


async def search_tmdb(query: str) -> list[TmdbCandidate]:
    """通过 TMDB 公开搜索页查询影视条目。"""
    query_string = urlencode({"query": query, "language": settings.tmdb_language})
    url = f"{settings.tmdb_base_url}/search?{query_string}"
    return parse_tmdb_search_html(await _get_html(url))


async def scrape_tmdb(tmdb_id: int, media_type: MediaType) -> TmdbMetadata:
    """按用户选择的媒体类型和 TMDB ID 刮削详情。"""
    query_string = urlencode({"language": settings.tmdb_language})
    url = f"{settings.tmdb_base_url}/{media_type}/{tmdb_id}?{query_string}"
    return parse_tmdb_detail_html(await _get_html(url), tmdb_id, media_type)


async def scrape_tmdb_artwork_urls(
    tmdb_id: int,
    media_type: MediaType,
    poster_url: str | None,
) -> TmdbArtworkUrls:
    """读取 TMDB 的背景图与 Logo 图片页，返回三张原图地址。"""
    query_string = urlencode({"language": settings.tmdb_language})
    base = f"{settings.tmdb_base_url}/{media_type}/{tmdb_id}/images"
    async def image_from(path: str) -> str | None:
        try:
            return parse_tmdb_image_page(await _get_html(path))
        except httpx.TransportError:
            return None

    # 两类图片并发且独立请求：缩短 TUN 连接异常时的总等待时间。
    fanart, clearlogo = await asyncio.gather(
        image_from(f"{base}/backdrops?{query_string}"),
        image_from(f"{base}/logos?{query_string}"),
    )
    return TmdbArtworkUrls(
        poster=poster_url,
        fanart=fanart,
        clearlogo=clearlogo,
    )
