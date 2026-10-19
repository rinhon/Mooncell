import json
import logging
import socket
import ssl

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.database import Base
from app.events import event_log_fields
from app.models import DomainEvent, FeedSource
from app.rss_service import describe_rss_exception


def test_timeout_exception_is_never_empty() -> None:
    message = describe_rss_exception(httpx.ReadTimeout(""))
    assert message.startswith("RSS 请求超时")
    assert "ReadTimeout" in message


def test_transport_exception_has_chinese_reason_and_type() -> None:
    message = describe_rss_exception(httpx.ConnectError("TLS EOF"))
    assert "HTTPS 安全连接被提前关闭" in message
    assert "ConnectError" in message


@pytest.mark.parametrize(("error", "reason", "code"), [
    (httpx.ConnectError("[SSL: TLSV1_ALERT_INTERNAL_ERROR] tlsv1 alert internal error "
                        "(_ssl.c:1010)"),
     "源站或代理返回 TLS 内部错误", "TLSV1_ALERT_INTERNAL_ERROR"),
    (httpx.ConnectError("[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed"),
     "HTTPS 证书校验失败", "CERTIFICATE_VERIFY_FAILED"),
    (httpx.ConnectError("[SSL: WRONG_VERSION_NUMBER] wrong version number"),
     "HTTPS 协议协商失败", "WRONG_VERSION_NUMBER"),
    (httpx.ProxyError("502 Bad Gateway"), "订阅代理连接失败", None),
    (httpx.ConnectError("[Errno 11001] getaddrinfo failed"), "域名解析失败", None),
    (httpx.ConnectError("All connection attempts failed"), "无法连接 RSS 源站或代理", None),
    (httpx.ReadError("Connection reset by peer"), "RSS 数据传输中断", None),
    (httpx.RemoteProtocolError("Server disconnected"), "RSS 数据传输中断", None),
])
def test_network_errors_are_explained_in_chinese(error, reason, code):
    message = describe_rss_exception(error)
    assert reason in message
    assert type(error).__name__ in message
    if code:
        assert code in message
    assert "(_ssl.c:" not in message


@pytest.mark.parametrize(("cause", "reason"), [
    (ssl.SSLCertVerificationError(1, "certificate verify failed"), "HTTPS 证书校验失败"),
    (ssl.SSLError(1, "[SSL: TLSV1_ALERT_INTERNAL_ERROR] tlsv1 alert internal error"),
     "源站或代理返回 TLS 内部错误"),
    (socket.gaierror(11001, "unknown host"), "域名解析失败"),
])
def test_wrapped_network_cause_is_detected(cause, reason):
    error = httpx.ConnectError("Connection failed")
    error.__cause__ = cause
    assert reason in describe_rss_exception(error)


def test_unrecognized_error_keeps_diagnostic_detail():
    assert describe_rss_exception(ValueError("RSS 缺少频道标题")) == "ValueError: RSS 缺少频道标题"


async def test_tls_failure_is_saved_and_logged_in_chinese(monkeypatch, caplog):
    from app import rss_service, subscription_settings

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with sessions() as session:
            source = FeedSource(name="测试订阅", url="https://example.test/rss")
            session.add(source)
            await session.commit()
            source_id = source.id

        original_client = httpx.AsyncClient

        def transport(request):
            raise httpx.ConnectError(
                "[SSL: TLSV1_ALERT_INTERNAL_ERROR] tlsv1 alert internal error (_ssl.c:1010)",
                request=request,
            )

        monkeypatch.setattr(subscription_settings, "SessionFactory", sessions)
        monkeypatch.setattr(rss_service.httpx, "AsyncClient", lambda **kwargs: original_client(
            transport=httpx.MockTransport(transport)))
        caplog.set_level(logging.WARNING, logger="app.subscription_settings")
        await subscription_settings.refresh_due_feeds()

        async with sessions() as session:
            saved = await session.get(FeedSource, source_id)
            event = await session.scalar(select(DomainEvent).where(
                DomainEvent.event_type == "feed.refresh.failed"))
            assert saved.connection_status == "error"
            assert "源站或代理返回 TLS 内部错误" in saved.last_error
            assert "TLSV1_ALERT_INTERNAL_ERROR" in saved.last_error
            payload = json.loads(event.payload)
            assert payload["error"] == saved.last_error
            level, scope, message = event_log_fields(event.event_type, payload)
            assert (level, scope) == ("error", "rss")
            assert message == f"RSS 刷新失败：{saved.last_error}"
            assert saved.last_error in caplog.text
            assert "(_ssl.c:1010)" not in caplog.text
    finally:
        await engine.dispose()
