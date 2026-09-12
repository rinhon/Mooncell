"""TMDB 三图刮削与本地番剧目录保存。"""

import asyncio
import re
import subprocess
import tempfile
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlparse, urlunparse

import httpx

from .config import settings
from .providers.tmdb import TmdbArtworkUrls, scrape_tmdb_artwork_urls, search_tmdb
from .schemas import TmdbMetadata


def store_uploaded_artwork(content: bytes, directory: Path, kind: str) -> Path:
    """用 ImageMagick 解码并规范化图片，验证成功后原子替换。"""
    if kind not in {"poster", "fanart", "clearlogo"}:
        raise ValueError("不支持的图片类型")
    if not content or len(content) > 10 * 1024 * 1024:
        raise ValueError("图片不能为空且不能超过 10 MB")
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        encoding = "png"
    elif content.startswith(b"\xff\xd8\xff"):
        encoding = "jpeg"
    elif content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        encoding = "webp"
    else:
        raise ValueError("仅支持 PNG、JPEG 和 WebP 图片")
    output = "png" if kind == "clearlogo" else "jpeg"
    result = subprocess.run(
        ["magick", "-limit", "memory", "128MiB", "-limit", "map", "256MiB",
         "-limit", "disk", "256MiB", "-limit", "width", "12000",
         "-limit", "height", "12000", f"{encoding}:-[0]", "-auto-orient", "-strip",
         *([] if output == "png" else ["-background", "white", "-alpha", "remove"]),
         f"{output}:-"],
        input=content, capture_output=True, timeout=30, check=False,
    )
    if result.returncode or not result.stdout:
        raise ValueError("图片损坏、尺寸过大或无法解码")
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / f"{kind}{'.png' if output == 'png' else '.jpg'}"
    with tempfile.NamedTemporaryFile(dir=directory, suffix=".tmp", delete=False) as temporary:
        temporary_path = Path(temporary.name)
        temporary.write(result.stdout)
    try:
        temporary_path.replace(target)
    finally:
        temporary_path.unlink(missing_ok=True)
    return target

@dataclass(slots=True)
class ArtworkResult:
    directory: str
    poster_path: str | None
    fanart_path: str | None
    clearlogo_path: str | None
    status: str
    error: str | None
    scraped_at: datetime


def safe_folder_name(name: str) -> str:
    """移除 Windows 文件名禁用字符，同时避免空目录名和尾随点。"""
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip().rstrip(".")
    return cleaned or "未命名番剧"


def _normalized_title(value: str) -> str:
    """移除空格与标点，用于判断 TMDB 候选是否属于同名或同系列作品。"""
    return "".join(character for character in value.casefold() if character.isalnum())


def _related_title(show_name: str, candidate_title: str) -> bool:
    current = _normalized_title(show_name)
    candidate = _normalized_title(candidate_title)
    return bool(
        candidate and (candidate == current or (len(candidate) >= 2 and candidate in current))
    )


async def _fill_missing_artwork(
    show_name: str,
    primary_tmdb_id: int,
    urls: TmdbArtworkUrls,
) -> TmdbArtworkUrls:
    """当前条目缺图时，按同名优先、同系列其次从搜索候选补齐。"""
    if urls.poster and urls.fanart and urls.clearlogo:
        return urls
    candidates = await search_tmdb(show_name)
    # 精确同名候选优先，随后才使用标题包含关系的系列条目。
    candidates.sort(
        key=lambda item: _normalized_title(item.title) != _normalized_title(show_name)
    )
    for candidate in candidates:
        if candidate.tmdb_id == primary_tmdb_id or not _related_title(show_name, candidate.title):
            continue
        try:
            alternate = await scrape_tmdb_artwork_urls(
                candidate.tmdb_id,
                candidate.media_type,
                candidate.poster_url,
            )
        except Exception:
            # 单个候选不可访问不应阻止继续尝试其余同系列条目。
            continue
        urls.poster = urls.poster or alternate.poster
        urls.fanart = urls.fanart or alternate.fanart
        urls.clearlogo = urls.clearlogo or alternate.clearlogo
        if urls.poster and urls.fanart and urls.clearlogo:
            break
    return urls


def _download_image_sync(url: str, target: Path) -> None:
    """同步下载单张图片；由异步入口调度到工作线程。"""
    parsed = urlparse(url)
    candidates = [url]
    # 当前部分 Windows TUN 节点会截断 TMDB CDN 的 TLS；仅官方图片域允许 HTTP 降级。
    if parsed.scheme == "https" and parsed.hostname in {
        "image.tmdb.org",
        "media.themoviedb.org",
    }:
        candidates.append(urlunparse(parsed._replace(scheme="http")))
    last_error: Exception | None = None
    for candidate_url in candidates:
        for attempt in range(4):
            with httpx.Client(
                timeout=settings.tmdb_timeout_seconds,
                follow_redirects=True,
                headers={"User-Agent": settings.tmdb_user_agent},
            ) as client:
                try:
                    response = client.get(candidate_url)
                    response.raise_for_status()
                    content_type = response.headers.get("content-type", "").lower()
                    if not content_type.startswith("image/"):
                        raise ValueError(f"TMDB CDN 返回了非图片内容：{content_type or '未知类型'}")
                    temporary = target.with_suffix(f"{target.suffix}.tmp")
                    temporary.write_bytes(response.content)
                    temporary.replace(target)
                    return
                except httpx.TransportError as exc:
                    last_error = exc
            time.sleep(min(0.35 * (2**attempt), 1.5))
    if last_error:
        raise last_error
    raise RuntimeError("TMDB 图片下载失败")


async def _download_image(url: str, target: Path) -> None:
    await asyncio.to_thread(_download_image_sync, url, target)


def _extension(url: str, fallback: str) -> str:
    suffix = Path(urlparse(url).path).suffix.lower()
    return suffix if suffix in {".jpg", ".jpeg", ".png", ".webp"} else fallback


async def scrape_and_store_artwork(
    show_name: str,
    metadata: TmdbMetadata,
    library_root: str | None = None,
) -> ArtworkResult:
    """把 poster、fanart、clearlogo 保存到媒体库的番剧名称目录。"""
    directory = Path(library_root or settings.media_library_root) / safe_folder_name(show_name)
    directory.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []

    def existing(kind: str) -> str | None:
        for extension in (".jpg", ".jpeg", ".png", ".webp"):
            candidate = directory / f"{kind}{extension}"
            if candidate.is_file():
                return str(candidate)
        return None

    # 重新刮削失败时保留此前成功落盘的图片，避免一次网络波动让卡片退化。
    paths: dict[str, str | None] = {
        "poster": existing("poster"),
        "fanart": existing("fanart"),
        "clearlogo": existing("clearlogo"),
    }
    try:
        urls = await scrape_tmdb_artwork_urls(
            metadata.tmdb_id,
            metadata.media_type,
            metadata.poster_url,
        )
        urls = await _fill_missing_artwork(show_name, metadata.tmdb_id, urls)
    except Exception as exc:
        detail = str(exc).strip() or "无法连接 TMDB"
        ready = sum(path is not None for path in paths.values())
        return ArtworkResult(
            directory=str(directory),
            poster_path=paths["poster"],
            fanart_path=paths["fanart"],
            clearlogo_path=paths["clearlogo"],
            status="completed" if ready == 3 else "partial" if ready else "failed",
            error=f"TMDB 图片请求失败：{exc.__class__.__name__} · {detail}",
            scraped_at=datetime.now(UTC),
        )

    for kind, url, fallback in (
        ("poster", urls.poster, ".jpg"),
        ("fanart", urls.fanart, ".jpg"),
        ("clearlogo", urls.clearlogo, ".png"),
    ):
        if not url:
            if not paths[kind]:
                errors.append(f"TMDB 未提供 {kind}")
            continue
        target = directory / f"{kind}{_extension(url, fallback)}"
        try:
            await _download_image(url, target)
            paths[kind] = str(target)
        except Exception as exc:
            if not paths[kind]:
                errors.append(f"{kind}: {exc.__class__.__name__} {str(exc).strip()}".strip())

    ready = sum(path is not None for path in paths.values())
    return ArtworkResult(
        directory=str(directory),
        poster_path=paths["poster"],
        fanart_path=paths["fanart"],
        clearlogo_path=paths["clearlogo"],
        status="completed" if ready == 3 else "partial" if ready else "failed",
        error="；".join(errors) or None,
        scraped_at=datetime.now(UTC),
    )
