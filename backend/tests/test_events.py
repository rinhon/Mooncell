import json
from datetime import UTC, datetime

from app.events import EventMessage, event_log_fields


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
