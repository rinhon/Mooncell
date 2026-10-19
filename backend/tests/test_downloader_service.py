import json
import logging

import httpx
import pytest
from sqlalchemy import select

from app import downloader_service as service
from app.downloader_service import extract_info_hash
from app.events import broker, event_log_fields
from app.models import DomainEvent, DownloaderConfig
from app.security import encrypt_secret


def test_extract_hash_from_mikan_torrent_url() -> None:
    assert extract_info_hash(
        "https://mikan.example/Download/20260824/eb804b2c8998b414617a071988b2de9290783631.torrent"
    ) == "eb804b2c8998b414617a071988b2de9290783631"


def test_extract_hex_hash_from_magnet() -> None:
    assert extract_info_hash(
        "magnet:?xt=urn:btih:EB804B2C8998B414617A071988B2DE9290783631&dn=Example"
    ) == "eb804b2c8998b414617a071988b2de9290783631"


def test_invalid_download_url_has_no_hash() -> None:
    assert extract_info_hash("https://example.test/download?id=12") is None


@pytest.fixture
def mock_downloader(monkeypatch):
    client_class = httpx.AsyncClient

    def install(handler):
        monkeypatch.setattr(service.httpx, "AsyncClient", lambda **kwargs: client_class(
            **kwargs, transport=httpx.MockTransport(handler),
        ))

    return install


@pytest.mark.parametrize(("error_type", "reason"), [
    (httpx.ReadTimeout, "等待下载器响应超时"),
    (httpx.ConnectTimeout, "连接下载器超时"),
    (httpx.ReadError, "读取下载器响应失败"),
    (httpx.ConnectError, "无法连接下载器"),
    (httpx.RemoteProtocolError, "下载器连接意外中断"),
    (RuntimeError, "RuntimeError"),
])
@pytest.mark.parametrize("kind", ["qbittorrent", "aria2"])
async def test_empty_exception_has_reason_and_server_log(
    mock_downloader, caplog, error_type, reason, kind,
):
    def fail(request):
        raise error_type("")

    mock_downloader(fail)
    with caplog.at_level(logging.WARNING, logger=service.__name__):
        result = await service.test_downloader(kind, "http://qb.test", "admin", "secret", True)
    assert not result.ok
    assert reason in result.message
    assert error_type.__name__ in result.message
    assert result.message in caplog.text


async def test_version_failure_identifies_stage(mock_downloader):
    def respond(request):
        if request.url.path.endswith("/login"):
            return httpx.Response(200, text="Ok.")
        raise httpx.ReadTimeout("")

    mock_downloader(respond)
    result = await service.test_qbittorrent("http://qb.test", "admin", "secret", True)
    assert not result.ok
    assert "读取版本失败" in result.message
    assert "ReadTimeout" in result.message


@pytest.mark.parametrize("status", [403, 404, 500])
async def test_login_http_failure_keeps_status(mock_downloader, status):
    mock_downloader(lambda request: httpx.Response(status))
    result = await service.test_qbittorrent("http://qb.test", "admin", "secret", True)
    assert not result.ok
    assert f"HTTP {status}" in result.message


async def test_error_response_and_log_redact_credentials(mock_downloader, caplog):
    def fail(request):
        raise httpx.ConnectError("TLS error https://alice:private@qb.test password=hidden")

    mock_downloader(fail)
    result = await service.test_qbittorrent("http://qb.test", "admin", "secret", True)
    assert "TLS error" in result.message
    for sensitive in ("alice", "private", "hidden"):
        assert sensitive not in result.message
        assert sensitive not in caplog.text


@pytest.mark.parametrize("login_status", [200, 204])
async def test_success_checks_session_version(mock_downloader, login_status):
    def respond(request):
        if request.url.path.endswith("/login"):
            return httpx.Response(login_status, text="Ok." if login_status == 200 else "",
                                  headers={"set-cookie": "SID=test-session; Path=/"})
        assert request.headers["cookie"] == "SID=test-session"
        return httpx.Response(200, text="v5.1.0\n")

    mock_downloader(respond)
    result = await service.test_qbittorrent("http://qb.test", "admin", "secret", True)
    assert result.ok
    assert result.version == "v5.1.0"


@pytest.mark.parametrize("saved", [False, True])
@pytest.mark.parametrize("healthy", [False, True])
async def test_connection_test_records_and_broadcasts_result(
    show_client, mock_downloader, saved, healthy,
):
    client, sessions, _ = show_client

    def respond(request):
        if not healthy:
            raise httpx.ReadTimeout("")
        return httpx.Response(200, text="Ok." if request.url.path.endswith("/login") else "v5.1")

    # 只替换下载器的客户端构造器，保留 fixture 已创建的 ASGI 客户端。
    mock_downloader(respond)
    payload = {"name": "qB", "kind": "qbittorrent", "base_url": "http://qb.test",
               "username": "admin", "secret": "private"}
    if saved:
        async with sessions() as session:
            session.add(DownloaderConfig(
                name="qB", kind="qbittorrent", base_url="http://qb.test", username="admin",
                encrypted_secret=encrypt_secret("private"),
            ))
            await session.commit()
    endpoint = "/downloaders/1/test" if saved else "/downloaders/test"
    async with broker.subscribe() as queue:
        response = await client.post(f"/api/v1{endpoint}", json=payload)
        assert response.status_code == 200
        assert response.json()["ok"] == healthy
        event = queue.get_nowait()
        assert queue.empty()
    async with sessions() as session:
        stored = await session.scalar(select(DomainEvent))
        assert stored.event_type == f"downloader.test.{'completed' if healthy else 'failed'}"
        assert event.event_type == stored.event_type
        assert json.loads(stored.payload)["message"] == response.json()["message"]
        assert "private" not in stored.payload
        level, scope, message = event_log_fields(stored.event_type, event.payload)
        assert level == ("info" if healthy else "error")
        assert scope == "downloader"
        assert ("成功" if healthy else "ReadTimeout") in message
        if saved:
            config = await session.get(DownloaderConfig, 1)
            assert config.connection_status == ("healthy" if healthy else "error")
            assert config.last_error == (None if healthy else response.json()["message"])
