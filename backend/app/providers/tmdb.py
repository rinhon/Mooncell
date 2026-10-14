"""通过 TMDB 官方 v3 API 搜索作品、读取元数据与图片。"""
import asyncio
from dataclasses import dataclass
from typing import Literal

import httpx

from ..config import settings
from ..schemas import TmdbCandidate, TmdbMetadata
from ..tmdb_settings import get_credentials

MediaType = Literal["tv", "movie"]
API_BASE = "https://api.themoviedb.org/3"
IMAGE_BASE = "https://image.tmdb.org/t/p/original"


@dataclass(slots=True)
class TmdbArtworkUrls:
    poster: str | None
    fanart: str | None
    clearlogo: str | None


def image_url(path: str | None) -> str | None:
    return f"{IMAGE_BASE}{path}" if path else None


async def _get_json(path: str, params: dict | None = None) -> dict:
    token, key = await get_credentials()
    if not token and not key:
        raise ValueError("请先在设置中配置 TMDB API 读访问令牌或 API 密钥")
    headers = {"Accept": "application/json", "User-Agent": settings.tmdb_user_agent}
    query = dict(params or {})
    if token:
        headers["Authorization"] = f"Bearer {token}"
    else:
        query["api_key"] = key
    # 不传播 httpx 原始异常，避免带 api_key 的请求 URL 进入界面或日志。
    async with httpx.AsyncClient(timeout=settings.tmdb_timeout_seconds) as client:
        for attempt in range(3):
            try:
                response = await client.get(f"{API_BASE}{path}", params=query, headers=headers)
            except httpx.TransportError:
                if attempt == 2:
                    raise RuntimeError("无法连接 TMDB API，请检查网络后重试") from None
                await asyncio.sleep(0.5 * (attempt + 1))
                continue
            if response.status_code == 429 or response.status_code >= 500:
                if attempt < 2:
                    await asyncio.sleep(0.5 * (attempt + 1))
                    continue
            if response.status_code in (401, 403):
                raise ValueError("TMDB API 认证失败，请检查设置中的令牌或密钥")
            if response.status_code == 404:
                raise ValueError("TMDB 条目不存在，请检查关联的 ID 和类型")
            if not response.is_success:
                raise RuntimeError(f"TMDB API 请求失败（HTTP {response.status_code}）")
            try:
                data = response.json()
            except ValueError:
                raise RuntimeError("TMDB API 返回了无效的 JSON 数据") from None
            if not isinstance(data, dict):
                raise RuntimeError("TMDB API 返回了无效的数据格式")
            return data
    raise RuntimeError("TMDB API 请求失败")


async def search_tmdb(query: str) -> list[TmdbCandidate]:
    data = await _get_json("/search/multi", {"query": query, "language": settings.tmdb_language,
                                           "include_adult": "false"})
    results = []
    for item in data.get("results", []):
        media_type = item.get("media_type")
        if media_type not in ("tv", "movie"):
            continue
        results.append(TmdbCandidate(
            tmdb_id=item["id"], media_type=media_type,
            title=item.get("name") or item.get("title") or "",
            original_title=item.get("original_name") or item.get("original_title"),
            release_date=item.get("first_air_date") or item.get("release_date") or None,
            overview=item.get("overview") or None, poster_url=image_url(item.get("poster_path")),
            href=f"{settings.tmdb_base_url}/{media_type}/{item['id']}",
        ))
    return results


def parse_tmdb_detail(data: dict, tmdb_id: int, media_type: MediaType) -> TmdbMetadata:
    return TmdbMetadata(
        tmdb_id=tmdb_id, media_type=media_type,
        title=data.get("name" if media_type == "tv" else "title") or "",
        overview=data.get("overview") or None,
        poster_url=image_url(data.get("poster_path")),
        release_date=data.get("first_air_date" if media_type == "tv" else "release_date") or None,
        genres=[item["name"] for item in data.get("genres", [])],
        episode_count=data.get("number_of_episodes") if media_type == "tv" else None,
        rating=data.get("vote_average"), vote_count=data.get("vote_count"),
        href=f"{settings.tmdb_base_url}/{media_type}/{tmdb_id}",
    )


async def scrape_tmdb(tmdb_id: int, media_type: MediaType) -> TmdbMetadata:
    data = await _get_json(f"/{media_type}/{tmdb_id}", {"language": settings.tmdb_language})
    return parse_tmdb_detail(data, tmdb_id, media_type)


def select_image(images: list[dict]) -> str | None:
    language = settings.tmdb_language.split("-")[0]
    preferences = list(dict.fromkeys([language, None, "en", "ja"]))
    usable = [item for item in images if item.get("file_path")]
    usable.sort(key=lambda item: (
        preferences.index(item.get("iso_639_1"))
        if item.get("iso_639_1") in preferences else len(preferences),
        -(item.get("vote_average") or 0), -(item.get("width") or 0),
    ))
    return image_url(usable[0]["file_path"]) if usable else None


async def scrape_tmdb_artwork_urls(
    tmdb_id: int, media_type: MediaType, poster_url: str | None,
) -> TmdbArtworkUrls:
    # 不传 language：取得全部语言图片，在本地优先中文，其次无文字、英文和日文。
    data = await _get_json(f"/{media_type}/{tmdb_id}/images")
    return TmdbArtworkUrls(
        poster=select_image(data.get("posters", [])) or poster_url,
        fanart=select_image(data.get("backdrops", [])),
        clearlogo=select_image(data.get("logos", [])),
    )
