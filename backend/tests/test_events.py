import json
from datetime import UTC, datetime

import httpx
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.events import EventMessage, describe_download_error, event_log_fields, record_event
from app.models import DomainEvent


def test_refresh_event_becomes_readable_log() -> None:
    level, scope, message = event_log_fields(
        "feed.refresh.completed",
        {"fetched": 12, "created": 2, "duplicates": 10},
    )
    assert level == "info"
    assert scope == "rss"
    assert message == "RSS 刷新完成：读取 12 条，新增 2 条，重复 10 条"


def test_log_message_redacts_credentials() -> None:
    _level, _scope, message = event_log_fields(
        "feed.refresh.failed",
        {"error": "password=hunter2 https://alice:secret@example.test/feed"},
    )
    assert "hunter2" not in message
    assert "alice" not in message
    assert "secret@example" not in message


def test_empty_legacy_error_has_fallback_message() -> None:
    level, scope, message = event_log_fields("feed.refresh.failed", {"error": ""})
    assert level == "error"
    assert scope == "rss"
    assert "未知错误" in message


@pytest.mark.parametrize(("error", "reason"), [
    ("ReadError: ", "读取下载器响应失败"),
    ("ConnectError: All connection attempts failed", "无法连接下载器"),
])
def test_legacy_download_failures_have_chinese_log_messages(error, reason):
    level, scope, message = event_log_fields("download.failed", {
        "error": error, "source_id": 1, "operation_id": None,
    })
    assert (level, scope) == ("error", "downloader")
    assert message.startswith(f"下载处理失败：{reason}")
    assert error.split(":", 1)[0] in message
    assert "download.failed" not in message
    assert "All connection attempts failed" not in message
    assert "source_id" not in message


@pytest.mark.parametrize("error", [httpx.ReadError(""), httpx.ConnectError(
    "All connection attempts failed")])
def test_download_error_translation_is_idempotent(error):
    translated = describe_download_error(error)
    assert describe_download_error(translated) == translated
    assert event_log_fields("download.failed", {"error": translated})[2] == (
        f"下载处理失败：{translated}"
    )


def test_download_error_keeps_diagnostics_and_redacts_credentials():
    original = "ConnectError: TLSV1_ALERT_INTERNAL_ERROR https://alice:secret@example.test"
    message = event_log_fields("download.failed", {"error": original})[2]
    assert "TLSV1_ALERT_INTERNAL_ERROR" in message
    assert "alice" not in message
    assert "secret" not in message
    assert "未知错误" in event_log_fields("download.failed", {})[2]


def test_download_retry_and_recovery_logs_are_chinese():
    failed = event_log_fields("download.failed", {"error": "连接失败", "retry_seconds": 30})
    assert "30 秒后自动重试" in failed[2]
    assert "最多 15 分钟" in failed[2]
    assert event_log_fields("download.recovered", {"title": "番名"}) == (
        "info", "downloader", "下载处理已恢复：番名",
    )
    assert "立即重试自动下载：番名" in event_log_fields(
        "download.automation.retry.requested", {"title": "番名"},
    )[2]


@pytest.mark.parametrize(("error", "message"), [
    (httpx.ReadTimeout("timed out"), "等待下载器响应超时"),
    (httpx.ConnectTimeout("timed out"), "连接下载器超时"),
    (httpx.RemoteProtocolError("disconnected"), "下载器连接意外中断"),
    (httpx.HTTPStatusError("error", request=httpx.Request("GET", "http://qb.test"),
                           response=httpx.Response(503)), "下载器接口请求失败（HTTP 503）"),
])
def test_download_retry_failures_have_actionable_chinese_reason(error, message):
    assert describe_download_error(error).startswith(message)


def test_artwork_failure_has_scraper_scope_and_error_message() -> None:
    level, scope, message = event_log_fields(
        "artwork.scrape.failed",
        {"name": "死神", "error": "ConnectError: 无法连接 TMDB"},
    )
    assert level == "error"
    assert scope == "scraper"
    assert message == "番剧图片刮削失败：死神 · ConnectError: 无法连接 TMDB"


def test_artwork_partial_is_warning() -> None:
    level, scope, message = event_log_fields(
        "artwork.scrape.partial",
        {"name": "死神", "error": "TMDB 未提供 clearlogo"},
    )
    assert level == "warning"
    assert scope == "scraper"
    assert "TMDB 未提供 clearlogo" in message


def test_sse_log_alias_contains_display_fields() -> None:
    message = EventMessage(
        id=7,
        event_type="feed.refresh.started",
        resource_type="feed_source",
        resource_id="3",
        payload={"name": "示例订阅"},
        created_at=datetime(2026, 8, 30, tzinfo=UTC),
    ).as_sse("log")
    assert "event: log" in message
    data_line = next(line for line in message.splitlines() if line.startswith("data: "))
    data = json.loads(data_line.removeprefix("data: "))
    assert data["scope"] == "rss"
    assert data["message"] == "开始刷新 RSS：示例订阅"


@pytest.mark.parametrize("resource_id", [3, "3", None])
def test_recorded_scan_event_can_be_streamed_after_commit(resource_id):
    engine = create_engine("sqlite://")
    try:
        DomainEvent.__table__.create(engine)
        with Session(engine, expire_on_commit=False) as session:
            event = record_event(session, "library.scan.changed", "feed_source", resource_id,
                                 {"name": "示例订阅", "thumbnails": 1})
            session.commit()
            message = EventMessage(
                id=event.id, event_type=event.event_type, resource_type=event.resource_type,
                resource_id=event.resource_id, payload=json.loads(event.payload),
                created_at=event.created_at,
            ).as_sse("log")
            data_line = next(line for line in message.splitlines() if line.startswith("data: "))
            data = json.loads(data_line.removeprefix("data: "))
            assert data["sourceId"] == (3 if resource_id is not None else None)
            assert data["type"] == "library.scan.changed"
            assert data["scope"] == "scraper"
    finally:
        engine.dispose()
