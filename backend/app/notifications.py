"""持久化后台操作；所有写入都参与调用方事务。"""

import json
from datetime import UTC, datetime
from uuid import NAMESPACE_URL, uuid5

from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert

from .events import _redact, commit_and_publish, record_event
from .models import BackgroundOperation, BackgroundOperationItem, DownloadJob, FeedSource, User

ACTIVE = ("queued", "running", "blocked")
TERMINAL = ("completed", "partial", "failed", "cancelled")
LABELS = {
    "feed_scrape": "订阅刮削",
    "metadata_refresh": "元数据更新",
    "artwork_scrape": "重新刮削",
    "library_migration": "文件整理",
    "download_added": "新增下载",
    "review_required": "任务审核",
}


def changed(session, operation):
    record_event(
        session,
        "notification.changed",
        "background_operation",
        operation.id,
        {
            "operation_id": operation.id,
            "revision": operation.revision,
            "source_id": operation.source_id,
            "user_id": operation.user_id,
            "summary": operation.summary,
        },
    )


async def create_operation(session, user_id, source, kind, *, context=None, migrations=None):
    operation = BackgroundOperation(
        user_id=user_id,
        source_id=source.id,
        source_name=source.name,
        kind=kind,
        context=context or {},
        total_count=len(migrations or []),
    )
    session.add(operation)
    await session.flush()
    for job_id, token in migrations or []:
        session.add(
            BackgroundOperationItem(
                operation_id=operation.id,
                download_job_id=job_id,
                migration_token=token,
            )
        )
    changed(session, operation)
    return operation


async def notify_task(session, item, kind, *, source=None, reason=None, user_id=None):
    """全局队列通知唯一管理员；同一条目和类型复用一条持久化提醒。"""
    if user_id is None:
        user_id = await session.scalar(select(User.id).order_by(User.id).limit(1))
    if user_id is None:
        return
    source = source or await session.get(FeedSource, item.source_id)
    if source is None:
        return
    # SQLite 可能复用已删除条目的 ID；加入发现时间，保留旧提醒且不漏报新任务。
    discovered = item.discovered_at.replace(tzinfo=UTC).isoformat()
    operation_id = str(
        uuid5(NAMESPACE_URL, f"mooncell/task/{user_id}/{kind}/{item.id}/{discovered}")
    )
    inserted = await session.scalar(
        insert(BackgroundOperation)
        .values(
            id=operation_id,
            user_id=user_id,
            kind=kind,
            source_id=source.id,
            source_name=source.name,
            context={"item_id": item.id},
        )
        .on_conflict_do_nothing(index_elements=["id"])
        .returning(BackgroundOperation.id)
    )
    operation = await session.get(BackgroundOperation, operation_id)
    if kind == "download_added":
        if inserted:
            transition(session, operation, "completed", f"新增下载任务：{item.title}")
    else:
        transition(session, operation, "blocked", f"任务需要审核：{item.title}", reason)
    return operation


async def resolve_task_review(session, item, *, ignored=False):
    operations = await session.scalars(
        select(BackgroundOperation).where(
            BackgroundOperation.kind == "review_required",
            BackgroundOperation.source_id == item.source_id,
            BackgroundOperation.context["item_id"].as_integer() == item.id,
            BackgroundOperation.status == "blocked",
        )
    )
    for operation in operations:
        operation.read_revision = operation.attention_revision
        operation.attention_key = None
        transition(
            session,
            operation,
            "cancelled" if ignored else "completed",
            f"已{'忽略' if ignored else '批准'}：{item.title}",
            attention=False,
        )


def transition(session, operation, status, summary, error=None, *, attention=True, key=None):
    error = _redact(error)[:1000] if error else None
    if (operation.status, operation.summary, operation.error_summary) == (status, summary, error):
        return
    operation.status, operation.summary, operation.error_summary = status, summary, error
    operation.updated_at = datetime.now(UTC)
    operation.revision += 1
    operation.finished_at = operation.updated_at if status in TERMINAL else None
    if attention and status in ("blocked", "completed", "partial", "failed"):
        attention_key = key or f"{status}:{error or ''}"
        if attention_key != operation.attention_key:
            operation.attention_key = attention_key
            operation.attention_revision = operation.revision
            operation.attention_at = operation.updated_at
    changed(session, operation)


async def cancel_source_operations(session, source_id):
    operations = list(
        await session.scalars(
            select(BackgroundOperation).where(
                BackgroundOperation.source_id == source_id,
            )
        )
    )
    for operation in operations:
        if operation.status in ACTIVE:
            transition(session, operation, "cancelled", "关联订阅已删除，操作已取消")
            for item in await session.scalars(
                select(BackgroundOperationItem).where(
                    BackgroundOperationItem.operation_id == operation.id,
                    BackgroundOperationItem.status.in_(ACTIVE),
                )
            ):
                item.status = "cancelled"
        operation.source_id = None
        # 包括已完成操作，以便所有设备刷新失效的详情入口。
        operation.revision += 1
        operation.updated_at = datetime.now(UTC)
        changed(session, operation)


async def aggregate_migration(session, operation):
    items = list(
        await session.scalars(
            select(BackgroundOperationItem).where(
                BackgroundOperationItem.operation_id == operation.id,
            )
        )
    )
    if not items or operation.status == "cancelled":
        return
    completed = sum(item.status == "completed" for item in items)
    count_changed = completed != operation.completed_count
    operation.completed_count = completed
    blocked = [item for item in items if item.status == "blocked"]
    progress = f"已完成 {completed} / {len(items)} 个下载任务"
    if completed == len(items):
        transition(
            session,
            operation,
            "completed",
            f"《{operation.source_name}》文件整理完成，已同步 {len(items)} 个下载任务",
        )
    elif blocked:
        transition(
            session,
            operation,
            "blocked",
            f"{progress}，需要处理",
            "；".join(dict.fromkeys(item.error_summary or "迁移受阻" for item in blocked)),
            key="blocked:" + ",".join(sorted({item.error_code or "unknown" for item in blocked})),
        )
    else:
        waiting = any(item.error_summary for item in items)
        previous_revision = operation.revision
        transition(
            session,
            operation,
            "running",
            progress + ("，等待重试" if waiting else ""),
            attention=False,
        )
        if count_changed and operation.revision == previous_revision:
            operation.revision += 1
            operation.updated_at = datetime.now(UTC)
            changed(session, operation)


async def update_migration(session, job, status, error=None, code=None, *, token=None):
    token = token or json.loads(job.plan or "{}").get("season_change", {}).get("token")
    query = select(BackgroundOperationItem).where(
        BackgroundOperationItem.download_job_id == job.id,
        BackgroundOperationItem.status.in_(ACTIVE),
    )
    if token:
        query = query.where(BackgroundOperationItem.migration_token == token)
    item = await session.scalar(query)
    if item is None:
        return
    item.status, item.error_code = status, code
    item.error_summary = _redact(error)[:1000] if error else None
    item.updated_at = datetime.now(UTC)
    await session.flush()
    operation = await session.get(BackgroundOperation, item.operation_id)
    await aggregate_migration(session, operation)
    return operation.id


async def reconcile_migrations(session):
    """下载任务被删除或忽略时也及时收敛，不依赖任务仍在执行队列中。"""
    items = list(
        await session.scalars(
            select(BackgroundOperationItem)
            .join(
                BackgroundOperation,
                BackgroundOperation.id == BackgroundOperationItem.operation_id,
            )
            .where(
                BackgroundOperation.status.in_(ACTIVE), BackgroundOperationItem.status.in_(ACTIVE)
            )
        )
    )
    operations = set()
    for item in items:
        job = await session.get(DownloadJob, item.download_job_id) if item.download_job_id else None
        if job is None or job.state in ("ignored", "superseded", "existing"):
            item.status, item.error_code = "blocked", "job_removed"
            item.error_summary = "下载任务已移除或不再执行，请检查下载中心"
            operations.add(item.operation_id)
        elif job.state == "done" and "season_change" not in json.loads(job.plan or "{}"):
            item.status, item.error_code, item.error_summary = "completed", None, None
            operations.add(item.operation_id)
    await session.flush()
    for operation_id in operations:
        await aggregate_migration(session, await session.get(BackgroundOperation, operation_id))


async def recover_operations(session):
    """在启动队列前，将刮削中断和持久化迁移重新汇总。"""
    operations = list(
        await session.scalars(
            select(BackgroundOperation).where(
                BackgroundOperation.status.in_(ACTIVE),
            )
        )
    )
    for operation in operations:
        if operation.kind in {"download_added", "review_required"}:
            continue
        if operation.kind != "library_migration":
            transition(
                session,
                operation,
                "failed",
                "服务重启导致刮削中断，请重新刮削",
                "订阅已保存；后台刮削未完成",
            )
            continue
        for item in await session.scalars(
            select(BackgroundOperationItem).where(
                BackgroundOperationItem.operation_id == operation.id,
                BackgroundOperationItem.status.in_(ACTIVE),
            )
        ):
            job = (
                await session.get(DownloadJob, item.download_job_id)
                if item.download_job_id
                else None
            )
            plan = json.loads(job.plan or "{}") if job else {}
            if job and job.state == "done" and "season_change" not in plan:
                item.status, item.error_summary, item.error_code = "completed", None, None
            elif job is None:
                item.status, item.error_code = "blocked", "job_removed"
                item.error_summary = "下载任务已移除，请检查下载中心"
        await session.flush()
        await aggregate_migration(session, operation)
    await commit_and_publish(session)
