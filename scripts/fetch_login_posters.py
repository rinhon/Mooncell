"""用本机已配置的 TMDB 凭据下载登录背景海报，并通过 ImageMagick 压缩。"""

import argparse
import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
OUTPUT = ROOT / "frontend" / "public" / "artwork" / "anime-posters"
IMAGE_BASE = "https://image.tmdb.org/t/p/w500"

# 用户筛选后的海报；保留初始总览编号，重新下载时不恢复已删除的作品。
SERIES = (
    (1, 30984, "bleach"),
    (4, 95479, "jujutsu-kaisen"),
    (5, 94664, "mushoku-tensei"),
    (9, 220542, "the-apothecary-diaries"),
    (10, 65942, "re-zero"),
    (14, 209867, "frieren"),
    (16, 120089, "spy-x-family"),
    (18, 46195, "monogatari"),
    (20, 127532, "solo-leveling"),
    (24, 67075, "mob-psycho-100"),
    (26, 43865, "psycho-pass"),
    (27, 1429, "attack-on-titan"),
    (28, 73223, "black-clover"),
    (30, 13916, "death-note"),
    (31, 83121, "kaguya-sama-love-is-war"),
    (34, 63926, "one-punch-man"),
    (37, 114410, "chainsaw-man"),
    (38, 240411, "dandadan"),
    (39, 85937, "demon-slayer"),
    (40, 42509, "steins-gate"),
    (41, 45500, "gundam-unicorn"),
    (43, 278704, "gundam-gquuuuuux"),
    (45, 60728, "kill-la-kill"),
    (47, 256721, "gachiakuta"),
    (48, 203737, "oshi-no-ko"),
    (49, 75208, "devilman-crybaby"),
)

MOVIES = (
    (25, 413594, "sword-art-online-ordinal-scale"),
    (33, 553837, "code-geass-lelouch-of-the-resurrection"),
    (42, 910850, "gundam-hathaway-the-sorcery-of-nymph-circe"),
    (46, 1218925, "chainsaw-man-reze-arc"),
)

# TMDB 将《我独自升级》两季合并为一季，使用核对过的第二季专属主视觉。
POSTER_OVERRIDES = {
    44: {
        "title": "我独自升级 第二季 -从暗影中崛起-",
        "posterPath": "/40V2Ui5r1oLK40SDRyWf387B7pt.jpg",
        "versionLabel": "Season 2 -Arise from the Shadow-",
    },
    50: {
        "title": "狂赌之渊××",
        "posterPath": "/puvGr9DVz8XSCNr39xs81tGyvs9.jpg",
        "versionLabel": "Season 2",
        "seasonNumber": 2,
    },
}

ARTWORK = sorted(
    [(number, "tv", media_id, slug) for number, media_id, slug in SERIES]
    + [(number, "movie", media_id, slug) for number, media_id, slug in MOVIES]
    + [(44, "tv", 127532, "solo-leveling-season-2")]
    + [(50, "tv", 72305, "kakegurui-xx")]
)


async def main(refresh: bool = False) -> None:
    magick = shutil.which("magick")
    if not magick:
        raise RuntimeError("请先安装 ImageMagick，并确保 magick 在 PATH 中")

    # 与本地开发后端保持相同的数据库和凭据读取方式，不输出或导出密钥。
    os.chdir(BACKEND)
    sys.path.insert(0, str(BACKEND))
    from app.database import engine
    from app.providers.tmdb import _get_json

    OUTPUT.mkdir(parents=True, exist_ok=True)
    cache = ROOT / ".cache" / "tmdb-posters"
    cache.mkdir(parents=True, exist_ok=True)
    semaphore = asyncio.Semaphore(4)
    manifest_path = OUTPUT / "manifest.json"
    previous = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    existing = {poster["previewNumber"]: poster for poster in previous.get("posters", [])}

    try:
        async with httpx.AsyncClient(timeout=45, follow_redirects=True) as client:
            with tempfile.TemporaryDirectory(dir=cache) as temporary:
                async def fetch(preview_number: int, media_type: str, series_id: int, slug: str) -> dict:
                    async with semaphore:
                        filename = f"{slug}-{series_id}.webp"
                        destination = OUTPUT / filename
                        override = POSTER_OVERRIDES.get(preview_number, {})
                        saved = existing.get(preview_number)
                        if (not refresh and saved and saved["tmdbId"] == series_id
                                and saved["mediaType"] == media_type and saved["filename"] == filename
                                and destination.exists() and destination.stat().st_size == saved["bytes"]
                                and (not override or (saved["sourceImage"].endswith(override["posterPath"])
                                                      and saved["title"] == override["title"]))):
                            return saved
                        item = await _get_json(f"/{media_type}/{series_id}", {"language": "zh-CN"})
                        if (item.get("adult") or item.get("original_language") != "ja"
                                or "JP" not in item.get("origin_country", [])
                                or not any(genre["id"] == 16 for genre in item.get("genres", []))):
                            raise RuntimeError(f"TMDB {series_id} 未通过日本动画校验")
                        poster_path = override.get("posterPath") or item.get("poster_path")
                        if not poster_path:
                            raise RuntimeError(f"TMDB {series_id} 没有海报")
                        title = override.get("title") or (
                            "电锯人" if series_id == 114410 else item.get("name") or item["title"]
                        )

                        source_url = f"{IMAGE_BASE}{poster_path}"
                        for attempt in range(3):
                            try:
                                response = await client.get(source_url)
                                response.raise_for_status()
                                if not response.headers.get("content-type", "").startswith("image/"):
                                    raise RuntimeError(f"TMDB {series_id} 返回的不是图片")
                                break
                            except httpx.HTTPError:
                                if attempt == 2:
                                    raise RuntimeError(f"TMDB {series_id} 海报下载失败") from None
                                await asyncio.sleep(attempt + 1)

                        asset_key = f"{preview_number}-{media_type}-{series_id}"
                        source = Path(temporary) / f"{asset_key}.jpg"
                        converted = Path(temporary) / f"{asset_key}.webp"
                        source.write_bytes(response.content)
                        result = await asyncio.to_thread(
                            subprocess.run,
                            [magick, str(source), "-auto-orient", "-colorspace", "sRGB",
                             "-resize", "480x720^", "-gravity", "center", "-extent", "480x720",
                             "-strip", "-quality", "80", "-define", "webp:method=6", str(converted)],
                            capture_output=True, check=False,
                        )
                        if result.returncode != 0:
                            raise RuntimeError(f"TMDB {series_id} 海报转换失败")
                        converted.replace(destination)
                        print(f"已下载：{title} ({series_id})", flush=True)
                        return {
                            "previewNumber": preview_number,
                            "tmdbId": series_id,
                            "mediaType": media_type,
                            "title": title,
                            "originalTitle": item.get("original_name") or item["original_title"],
                            **({"versionLabel": override["versionLabel"]} if override else {}),
                            "filename": filename,
                            "src": f"/artwork/anime-posters/{filename}",
                            "sourcePage": f"https://www.themoviedb.org/{media_type}/{series_id}"
                            + (f"/season/{override['seasonNumber']}" if "seasonNumber" in override else ""),
                            "sourceImage": source_url,
                            "originalImage": f"https://image.tmdb.org/t/p/original{poster_path}",
                            "popularity": item.get("popularity"),
                            "voteCount": item.get("vote_count"),
                            "width": 480,
                            "height": 720,
                            "bytes": (OUTPUT / filename).stat().st_size,
                        }

                posters = await asyncio.gather(*(fetch(*artwork) for artwork in ARTWORK))

        manifest = {
            "source": "TMDB",
            "downloadedAt": datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds"),
            "selection": "按用户指定作品与版本筛选；已有 previewNumber 保持不变，新作品顺延编号。",
            "format": "webp",
            "quality": 80,
            "count": len(posters),
            "totalBytes": sum(poster["bytes"] for poster in posters),
            "attribution": "This product uses the TMDB API but is not endorsed or certified by TMDB.",
            "posters": posters,
        }
        temporary_manifest = OUTPUT / "manifest.json.tmp"
        temporary_manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary_manifest.replace(OUTPUT / "manifest.json")
        print(f"完成：{len(posters)} 张海报，{manifest['totalBytes'] / 1024 / 1024:.2f} MiB")
    finally:
        await engine.dispose()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true", help="重新下载全部海报，默认复用已有素材")
    args = parser.parse_args()
    try:
        asyncio.run(main(refresh=args.refresh))
    except (RuntimeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
