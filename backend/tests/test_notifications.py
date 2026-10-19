import asyncio
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI, Request
from sqlalchemy import event, func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import api
from app.artwork_service import ArtworkResult
from app.database import Base, get_session
from app.dependencies import optional_user
from app.events import broker, commit_and_publish, record_event
from app.models import (
    BackgroundOperation,
    BackgroundOperationItem,
    DomainEvent,
    DownloaderConfig,
    DownloadJob,
    FeedItem,
    FeedSource,
    ShowArtwork,
    ShowMetadata,
    User,
)
from app.notification_api import router
from app.notifications import (
    aggregate_migration,
    create_operation,
    recover_operations,
    transition,
    update_migration,
)
from app.schemas import TmdbMetadata


@pytest.fixture
async def notification_app(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'notifications.db'}")

    @event.listens_for(engine.sync_engine, "connect")
    def foreign_keys(connection, _):
        connection.execute("PRAGMA foreign_keys=ON")

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as session:
        session.add_all([User(id=n, username=f"user{n}", password_hash="test") for n in (1, 2)])
        source = FeedSource(id=1, name="测试番剧", url="https://example.test/rss")
        source.show_metadata = ShowMetadata(
            tmdb_id=123, media_type="tv", title="旧标题", href="https://example.test/123"
        )
        source.artwork = ShowArtwork(directory=str(tmp_path / "library"))
        session.add(source)
        session.add(
            DownloaderConfig(id=1, name="qB", kind="qbittorrent", base_url="http://qb.test")
        )
        await session.commit()
    app = FastAPI()
    app.include_router(api.router)
    app.include_router(router)

    async def user_override(request: Request):
        user_id = request.headers.get("x-test-user")
        return User(id=int(user_id)) if user_id in ("1", "2") else None

    async def session_override():
        async with sessions() as session:
            yield session

    app.dependency_overrides[optional_user] = user_override
    app.dependency_overrides[get_session] = session_override
    monkeypatch.setattr(api, "SessionFactory", sessions)
    monkeypatch.setattr(api, "get_library_root", AsyncMock(return_value=str(tmp_path / "library")))
    monkeypatch.setattr(
        api,
        "scrape_tmdb",
        AsyncMock(
            return_value=TmdbMetadata(
                tmdb_id=123,
                media_type="tv",
                title="新标题",
                href="https://example.test/123",
            )
        ),
    )

    async def artwork(name, metadata, root):
        directory = Path(root) / name
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / "poster.jpg"
        path.write_bytes(str(metadata.tmdb_id).encode())
        return ArtworkResult(
            str(directory), str(path), None, None, "partial", "缺少图片", datetime.now(UTC)
        )

    monkeypatch.setattr(api, "scrape_and_store_artwork", artwork)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app), base_url="http://test", headers={"x-test-user": "1"}
    ) as client:
        yield client, sessions, app
    await engine.dispose()


async def make_operation(sessions, *, user_id=1, kind="feed_scrape", status="completed"):
    async with sessions() as session:
        operation = await create_operation(session, user_id, await session.get(FeedSource, 1), kind)
        if status != "queued":
            transition(session, operation, status, "测试结果")
        await commit_and_publish(session)
        return operation.id


async def test_authentication_and_ownership(notification_app):
    client, sessions, _ = notification_app
    operation_id = await make_operation(sessions, user_id=2)
    for method, path, body in [
        ("GET", "/notifications", None),
        ("GET", "/notifications/summary", None),
        ("GET", f"/notifications/{operation_id}", None),
        ("PATCH", f"/notifications/{operation_id}/read", {"attention_revision": 999}),
        ("POST", "/notifications/read-all", {"cutoff": datetime.now(UTC).isoformat()}),
    ]:
        response = await client.request(
            method, "/api/v1" + path, json=body, headers={"x-test-user": ""}
        )
        assert response.status_code == 401
    assert (await client.get("/api/v1/notifications")).json()["items"] == []
    assert (await client.get(f"/api/v1/notifications/{operation_id}")).status_code == 404
    assert (
        await client.patch(
            f"/api/v1/notifications/{operation_id}/read", json={"attention_revision": 999}
        )
    ).status_code == 404
    await client.post(
        "/api/v1/notifications/read-all", json={"cutoff": datetime.now(UTC).isoformat()}
    )
    async with sessions() as session:
        operation = await session.get(BackgroundOperation, operation_id)
        assert operation.attention_revision > operation.read_revision


async def test_observed_revision_does_not_read_new_result_or_regress(notification_app):
    client, sessions, _ = notification_app
    operation_id = await make_operation(sessions, status="blocked")
    before = (await client.get(f"/api/v1/notifications/{operation_id}")).json()
    async with sessions() as session:
        operation = await session.get(BackgroundOperation, operation_id)
        transition(session, operation, "running", "继续迁移", attention=False)
        transition(session, operation, "completed", "已完成")
        await commit_and_publish(session)
    response = await client.patch(
        f"/api/v1/notifications/{operation_id}/read",
        json={"attention_revision": before["attention_revision"]},
    )
    assert response.json()["unread"] is True
    current = response.json()["attention_revision"]
    for revision in (current, before["attention_revision"], current):
        response = await client.patch(
            f"/api/v1/notifications/{operation_id}/read", json={"attention_revision": revision}
        )
        assert response.json()["unread"] is False
        assert response.json()["read_revision"] == current


async def test_read_all_snapshot_preserves_later_result(notification_app):
    client, sessions, _ = notification_app
    old_id = await make_operation(sessions)
    changing_id = await make_operation(sessions, status="blocked")
    snapshot = (await client.get("/api/v1/notifications")).json()
    async with sessions() as session:
        operation = await session.get(BackgroundOperation, changing_id)
        transition(session, operation, "completed", "刚刚完成")
        await commit_and_publish(session)
    response = await client.post(
        "/api/v1/notifications/read-all", json={"cutoff": snapshot["cutoff"]}
    )
    assert response.json()["unread_count"] == 1
    assert not (await client.get(f"/api/v1/notifications/{old_id}")).json()["unread"]
    assert (await client.get(f"/api/v1/notifications/{changing_id}")).json()["unread"]


async def test_history_over_200_and_cursor_ties_and_active_items(notification_app):
    client, sessions, _ = notification_app
    async with sessions() as session:
        timestamp = datetime.now(UTC)
        for index in range(211):
            session.add(
                BackgroundOperation(
                    id=f"operation-{index:04d}",
                    user_id=1,
                    source_id=1,
                    source_name="番剧",
                    kind="feed_scrape",
                    status="completed",
                    updated_at=timestamp,
                    revision=2,
                    attention_revision=2,
                    attention_at=timestamp,
                )
            )
        session.add(
            BackgroundOperation(
                id="active",
                user_id=1,
                source_id=1,
                source_name="番剧",
                kind="feed_scrape",
                status="running",
                updated_at=timestamp - timedelta(days=1),
            )
        )
        await session.commit()
    ids, cursor = [], ""
    while True:
        response = await client.get(
            "/api/v1/notifications",
            params={"limit": 20, "cursor": cursor} if cursor else {"limit": 20},
        )
        page = response.json()
        assert page["unread_count"] == 211
        assert [row["id"] for row in page["active_items"]] == ["active"]
        ids.extend(row["id"] for row in page["items"])
        cursor = page["next_cursor"]
        if not cursor:
            break
    assert len(ids) == len(set(ids)) == 212
    assert (await client.get("/api/v1/notifications?cursor=invalid")).status_code == 422


async def test_progress_retry_dedup_and_final_result(notification_app):
    client, sessions, _ = notification_app
    async with sessions() as session:
        source = await session.get(FeedSource, 1)
        for index in (1, 2):
            session.add(
                FeedItem(
                    id=index, source_id=1, title="发布", fingerprint=str(index), parse_data="{}"
                )
            )
        await session.flush()
        for index in (1, 2):
            session.add(
                DownloadJob(
                    id=index,
                    item_id=index,
                    info_hash=str(index) * 40,
                    downloader_id=1,
                    target_root="/library",
                    title="番剧",
                    season=1,
                )
            )
        await session.flush()
        operation = await create_operation(
            session, 1, source, "library_migration", migrations=[(1, "a" * 32), (2, "b" * 32)]
        )
        first, second = await session.get(DownloadJob, 1), await session.get(DownloadJob, 2)
        await update_migration(session, first, "running", "网络异常，等待重试", "retrying")
        assert operation.attention_revision == 0
        await update_migration(
            session, first, "blocked", "目标路径冲突 token=secret", "path_conflict"
        )
        attention = operation.attention_revision
        operation.read_revision = attention
        for _ in range(3):
            await update_migration(
                session, first, "blocked", "目标路径冲突 token=secret", "path_conflict"
            )
        assert operation.attention_revision == attention
        assert "secret" not in operation.error_summary
        await update_migration(session, first, "completed")
        assert operation.completed_count == 1
        assert operation.status == "running"
        assert operation.attention_revision == attention
        await update_migration(session, first, "completed")
        assert operation.completed_count == 1
        await update_migration(session, second, "completed")
        assert operation.status == "completed"
        assert operation.completed_count == 2
        assert operation.attention_revision > operation.read_revision
        revision = operation.revision
        await aggregate_migration(session, operation)
        assert operation.revision == revision
        await commit_and_publish(session)
    assert (await client.get("/api/v1/notifications")).json()["unread_count"] == 1


async def test_restart_interrupts_scrapes_and_keeps_migration_active(notification_app):
    _, sessions, _ = notification_app
    scrape_id = await make_operation(sessions, status="queued")
    async with sessions() as session:
        source = await session.get(FeedSource, 1)
        operation = await create_operation(session, 1, source, "library_migration")
        operation.total_count = 1
        session.add(BackgroundOperationItem(operation_id=operation.id, migration_token="c" * 32))
        await session.commit()
        await recover_operations(session)
        scrape = await session.get(BackgroundOperation, scrape_id)
        assert scrape.status == "failed" and "中断" in scrape.summary
        assert operation.status == "blocked"
        assert "移除" in operation.error_summary


async def test_delete_preserves_history_and_cancels_pending(notification_app):
    client, sessions, _ = notification_app
    completed = await make_operation(sessions)
    pending = await make_operation(sessions, status="queued")
    assert (await client.delete("/api/v1/feeds/1")).status_code == 200
    for operation_id in (completed, pending):
        detail = (await client.get(f"/api/v1/notifications/{operation_id}")).json()
        assert detail["source_id"] is None
        assert detail["source_name"] == "测试番剧"
        assert detail["status"] == ("completed" if operation_id == completed else "cancelled")


async def test_events_only_broadcast_after_successful_commit(notification_app):
    _, sessions, _ = notification_app
    async with broker.subscribe() as queue, sessions() as session:
        record_event(session, "test.changed", "test", "1", {})
        assert queue.empty()
        await session.rollback()
        await commit_and_publish(session)
        assert queue.empty()
        record_event(session, "test.changed", "test", "2", {})
        await commit_and_publish(session)
        assert queue.get_nowait().resource_id == "2"
        assert await session.scalar(select(func.count(DomainEvent.id))) == 1


async def test_manual_rescrape_202_response_precedes_background_result(
    notification_app, monkeypatch
):
    client, sessions, app = notification_app
    started, release, sent = asyncio.Event(), asyncio.Event(), asyncio.Event()
    original = api.scrape_tmdb
    body = bytearray()

    async def slow(*args):
        started.set()
        await release.wait()
        return await original(*args)

    async def observed(scope, receive, send):
        async def observe(message):
            if message["type"] == "http.response.body":
                body.extend(message.get("body", b""))
                sent.set()
            await send(message)

        await app(scope, receive, observe)

    monkeypatch.setattr(api, "scrape_tmdb", slow)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(observed),
        base_url="http://test",
        headers={"x-test-user": "1"},
    ) as observed_client:
        task = asyncio.create_task(observed_client.post("/api/v1/shows/1/rescrape"))
        try:
            await asyncio.wait_for(started.wait(), 3)
            assert sent.is_set()
            async with sessions() as session:
                operation = await session.scalar(select(BackgroundOperation))
                assert operation.status == "running" and operation.attention_revision == 0
        finally:
            release.set()
        response = await task
    assert response.status_code == 202
    operation_id = response.json()["background_operation_ids"][0]
    detail = (await client.get(f"/api/v1/notifications/{operation_id}")).json()
    assert detail["kind"] == "artwork_scrape" and detail["status"] == "partial"
    assert detail["unread"]


async def test_stale_scrape_does_not_write_metadata_or_images(
    notification_app, monkeypatch, tmp_path
):
    client, sessions, _ = notification_app
    original = api.scrape_and_store_artwork

    async def stale(*args):
        result = await original(*args)
        async with sessions() as session:
            source = await session.get(FeedSource, 1)
            source.show_metadata.tmdb_id = 999
            source.show_metadata.title = "最新关联"
            await session.commit()
        return result

    monkeypatch.setattr(api, "scrape_and_store_artwork", stale)
    response = await client.post("/api/v1/shows/1/rescrape")
    operation_id = response.json()["background_operation_ids"][0]
    assert (await client.get(f"/api/v1/notifications/{operation_id}")).json()[
        "status"
    ] == "cancelled"
    async with sessions() as session:
        source = await session.get(FeedSource, 1)
        assert source.show_metadata.title == "最新关联"
        assert source.artwork.poster_path is None
    assert not (tmp_path / "library" / "测试番剧" / "poster.jpg").exists()


async def test_no_migration_notification_for_ordinary_edit_or_no_downloads(notification_app):
    client, sessions, _ = notification_app
    for body in ({"active": False}, {"season": 2}, {"name": "新的番名"}):
        response = await client.patch("/api/v1/feeds/1", json=body)
        assert response.status_code == 200
        assert response.json()["background_operation_ids"] == []
    async with sessions() as session:
        assert await session.scalar(select(func.count(BackgroundOperation.id))) == 0


async def test_rescrape_newer_request_cancels_older_even_with_same_tmdb(
    notification_app, monkeypatch
):
    client, sessions, _ = notification_app
    original = api.scrape_and_store_artwork

    async def replace_request(*args):
        result = await original(*args)
        async with sessions() as session:
            source = await session.get(FeedSource, 1)
            await api._create_scrape_operation(session, 1, source, "metadata_refresh")
            await commit_and_publish(session)
        return result

    monkeypatch.setattr(api, "scrape_and_store_artwork", replace_request)
    response = await client.post("/api/v1/shows/1/rescrape")
    operation_id = response.json()["background_operation_ids"][0]
    detail = (await client.get(f"/api/v1/notifications/{operation_id}")).json()
    assert detail["status"] == "cancelled"
    async with sessions() as session:
        source = await session.get(FeedSource, 1)
        assert source.show_metadata.title == "旧标题"
        assert source.artwork.poster_path is None


async def test_metadata_failure_preserves_previously_scraped_fields(notification_app, monkeypatch):
    client, sessions, _ = notification_app
    monkeypatch.setattr(api, "scrape_tmdb", AsyncMock(side_effect=httpx.ReadTimeout("离线")))
    response = await client.post("/api/v1/shows/1/rescrape")
    operation_id = response.json()["background_operation_ids"][0]
    assert (await client.get(f"/api/v1/notifications/{operation_id}")).json()["unread"]
    async with sessions() as session:
        assert (await session.get(FeedSource, 1)).show_metadata.title == "旧标题"
