"""下载器 Web API 连通性检查与实时状态查询。"""

from __future__ import annotations

import base64
import logging
import re
from dataclasses import dataclass
from urllib.parse import parse_qs, urlparse

import httpx

from .events import _redact, describe_download_error
from .schemas import DownloaderTestResult

_TORRENT_HASH = re.compile(r"([0-9a-fA-F]{40})(?:\.torrent)?(?:\?|$)")
logger = logging.getLogger(__name__)


def _test_failure(kind: str, message: str) -> DownloaderTestResult:
    message = _redact(message)
    logger.warning("下载器连接测试失败：%s", message)
    return DownloaderTestResult(ok=False, kind=kind, message=message)


@dataclass(slots=True)
class QbittorrentSnapshot:
    version: str
    download_speed: int
    upload_speed: int
    torrents: dict[str, dict]


def extract_info_hash(download_url: str | None) -> str | None:
    """从 magnet 的 btih 或 Mikan torrent 文件名提取标准 40 位 info-hash。"""
    if not download_url:
        return None
    if download_url.lower().startswith("magnet:"):
        values = parse_qs(urlparse(download_url).query).get("xt", [])
        for value in values:
            if not value.lower().startswith("urn:btih:"):
                continue
            raw_hash = value.rsplit(":", 1)[-1]
            if re.fullmatch(r"[0-9a-fA-F]{40}", raw_hash):
                return raw_hash.lower()
            if re.fullmatch(r"[A-Z2-7]{32}", raw_hash.upper()):
                return base64.b32decode(raw_hash.upper()).hex()
    match = _TORRENT_HASH.search(download_url)
    return match.group(1).lower() if match else None


async def get_qbittorrent_snapshot(
    base_url: str,
    username: str | None,
    secret: str | None,
    verify_tls: bool,
    hashes: list[str],
) -> QbittorrentSnapshot:
    """登录 qBittorrent，并只读取数据库记录对应的种子及全局速率。"""
    async with httpx.AsyncClient(
        base_url=base_url,
        timeout=httpx.Timeout(10),
        verify=verify_tls,
    ) as client:
        response = await client.post(
            "/api/v2/auth/login",
            data={"username": username or "", "password": secret or ""},
        )
        login_ok = response.status_code == 204 or (
            response.status_code == 200 and response.text.startswith("Ok")
        )
        if not login_ok:
            raise ValueError("qBittorrent 拒绝登录，请检查地址和凭据")
        version_response = await client.get("/api/v2/app/version")
        version_response.raise_for_status()
        transfer_response = await client.get("/api/v2/transfer/info")
        transfer_response.raise_for_status()
        torrents: list[dict] = []
        if hashes:
            torrent_response = await client.get(
                "/api/v2/torrents/info",
                params={"hashes": "|".join(hashes)},
            )
            torrent_response.raise_for_status()
            torrents = torrent_response.json()
        transfer = transfer_response.json()
        return QbittorrentSnapshot(
            version=version_response.text.strip(),
            download_speed=int(transfer.get("dl_info_speed", 0)),
            upload_speed=int(transfer.get("up_info_speed", 0)),
            torrents={str(item.get("hash", "")).lower(): item for item in torrents},
        )


async def test_qbittorrent(
    base_url: str,
    username: str | None,
    secret: str | None,
    verify_tls: bool,
) -> DownloaderTestResult:
    """登录 qBittorrent Web API，并读取版本验证 Cookie 会话可用。"""
    stage = "登录 Web API"
    try:
        async with httpx.AsyncClient(
            base_url=base_url,
            timeout=httpx.Timeout(10),
            verify=verify_tls,
        ) as client:
            response = await client.post(
                "/api/v2/auth/login",
                data={"username": username or "", "password": secret or ""},
            )
            response.raise_for_status()
            login_ok = response.status_code == 204 or (
                response.status_code == 200 and response.text.startswith("Ok")
            )
            if not login_ok:
                return _test_failure(
                    "qbittorrent", "qBittorrent 拒绝登录，请检查地址和凭据",
                )
            stage = "读取版本"
            version_response = await client.get("/api/v2/app/version")
            version_response.raise_for_status()
            return DownloaderTestResult(
                ok=True,
                kind="qbittorrent",
                version=version_response.text.strip(),
                message="qBittorrent 连接正常",
            )
    except Exception as exc:
        return _test_failure(
            "qbittorrent",
            f"无法连接 qBittorrent：{stage}失败；{describe_download_error(exc)}",
        )


async def test_aria2(
    base_url: str,
    secret: str | None,
    verify_tls: bool,
) -> DownloaderTestResult:
    """调用 aria2.getVersion 验证 JSON-RPC 地址和 Secret。"""
    params: list[str] = [f"token:{secret}"] if secret else []
    payload = {
        "jsonrpc": "2.0",
        "id": "mooncell-health",
        "method": "aria2.getVersion",
        "params": params,
    }
    try:
        async with httpx.AsyncClient(timeout=10, verify=verify_tls) as client:
            response = await client.post(base_url, json=payload)
            response.raise_for_status()
            data = response.json()
            if "error" in data:
                return _test_failure(
                    "aria2", f"aria2 RPC 返回错误：{data['error'].get('message', '未知错误')}",
                )
            return DownloaderTestResult(
                ok=True,
                kind="aria2",
                version=data.get("result", {}).get("version"),
                message="aria2 连接正常",
            )
    except Exception as exc:
        return _test_failure("aria2", f"无法连接 aria2：{describe_download_error(exc)}")


async def test_downloader(
    kind: str,
    base_url: str,
    username: str | None,
    secret: str | None,
    verify_tls: bool,
) -> DownloaderTestResult:
    """按下载器类型分发连接测试。"""
    if kind == "qbittorrent":
        return await test_qbittorrent(base_url, username, secret, verify_tls)
    if kind == "aria2":
        return await test_aria2(base_url, secret, verify_tls)
    return DownloaderTestResult(ok=False, kind=kind, message="不支持的下载器类型")
