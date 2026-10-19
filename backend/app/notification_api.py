"""仅向发起者提供提醒；数据库是历史与未读数的唯一来源。"""

import base64
import json
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import and_, case, func, or_, select, update

from .database import get_session
from .dependencies import require_user
from .events import commit_and_publish
from .models import BackgroundOperation as Operation
from .models import BackgroundOperationItem as Item
from .notifications import ACTIVE, changed

router = APIRouter(prefix="/api/v1/notifications", tags=["notifications"])


def serialize(operation):
    fields = (
        "id",
        "kind",
        "source_id",
        "source_name",
        "status",
        "total_count",
        "completed_count",
        "summary",
        "error_summary",
        "created_at",
        "updated_at",
        "finished_at",
        "revision",
        "attention_revision",
        "read_revision",
    )
    result = {field: getattr(operation, field) for field in fields}
    for field in ("created_at", "updated_at", "finished_at"):
        if result[field]:
            result[field] = result[field].replace(tzinfo=UTC).isoformat()
    result["unread"] = operation.attention_revision > operation.read_revision
    return result


async def summary(session, user_id):
    unread, active = (
        await session.execute(
            select(
                func.count().filter(Operation.attention_revision > Operation.read_revision),
                func.count().filter(Operation.status.in_(ACTIVE)),
            ).where(Operation.user_id == user_id)
        )
    ).one()
    return {"unread_count": unread, "active_count": active}


@router.get("/summary")
async def get_summary(user=Depends(require_user), session=Depends(get_session)):
    return await summary(session, user.id)


@router.get("")
async def list_notifications(
    cursor: str | None = None,
    limit: int = Query(20, ge=1, le=100),
    user=Depends(require_user),
    session=Depends(get_session),
):
    cutoff = datetime.now(UTC)
    query = select(Operation).where(Operation.user_id == user.id)
    if cursor:
        try:
            timestamp, operation_id = json.loads(base64.urlsafe_b64decode(cursor))
            timestamp = datetime.fromisoformat(timestamp)
            if not isinstance(operation_id, str):
                raise ValueError
        except (ValueError, TypeError, KeyError, UnicodeError) as exc:
            raise HTTPException(422, "无效的分页游标") from exc
        query = query.where(
            or_(
                Operation.updated_at < timestamp,
                and_(
                    Operation.updated_at == timestamp,
                    Operation.id < operation_id,
                ),
            )
        )
    rows = list(
        await session.scalars(
            query.order_by(
                Operation.updated_at.desc(),
                Operation.id.desc(),
            ).limit(limit + 1)
        )
    )
    items = rows[:limit]
    next_cursor = None
    if len(rows) > limit:
        last = items[-1]
        next_cursor = base64.urlsafe_b64encode(
            json.dumps(
                [
                    last.updated_at.isoformat(),
                    last.id,
                ]
            ).encode()
        ).decode()
    # 活动项独立查询，不会因最近提醒超过一页而从“进行中”消失。
    active = list(
        await session.scalars(
            select(Operation)
            .where(
                Operation.user_id == user.id,
                Operation.status.in_(ACTIVE),
            )
            .order_by(Operation.updated_at.desc(), Operation.id.desc())
        )
    )
    return {
        "items": [serialize(row) for row in items],
        "active_items": [serialize(row) for row in active],
        "next_cursor": next_cursor,
        "cutoff": cutoff.isoformat(),
        **await summary(session, user.id),
    }


class ReadAll(BaseModel):
    cutoff: datetime


@router.post("/read-all")
async def read_all(data: ReadAll, user=Depends(require_user), session=Depends(get_session)):
    cutoff = min(
        data.cutoff.astimezone(UTC) if data.cutoff.tzinfo else data.cutoff.replace(tzinfo=UTC),
        datetime.now(UTC),
    )
    # 原子条件更新：快照之后产生的新 attention 不会被本请求标为已读。
    ids = list(
        (
            await session.execute(
                update(Operation)
                .where(
                    Operation.user_id == user.id,
                    Operation.attention_at <= cutoff,
                    Operation.attention_revision > Operation.read_revision,
                )
                .values(read_revision=Operation.attention_revision)
                .returning(Operation.id)
            )
        ).scalars()
    )
    for operation_id in ids:
        changed(session, await session.get(Operation, operation_id))
    await commit_and_publish(session)
    return await summary(session, user.id)


async def owned(session, user_id, operation_id):
    operation = await session.scalar(
        select(Operation).where(
            Operation.id == operation_id,
            Operation.user_id == user_id,
        )
    )
    if operation is None:
        raise HTTPException(404, "提醒不存在")
    return operation


@router.get("/{operation_id}")
async def detail(
    operation_id: str,
    offset: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    user=Depends(require_user),
    session=Depends(get_session),
):
    operation = await owned(session, user.id, operation_id)
    rows = list(
        await session.scalars(
            select(Item)
            .where(
                Item.operation_id == operation.id,
            )
            .order_by(Item.id)
            .offset(offset)
            .limit(limit + 1)
        )
    )
    return {
        **serialize(operation),
        "items": [
            {
                "id": row.id,
                "download_job_id": row.download_job_id,
                "status": row.status,
                "error_code": row.error_code,
                "error_summary": row.error_summary,
            }
            for row in rows[:limit]
        ],
        "next_offset": offset + limit if len(rows) > limit else None,
    }


class ReadOne(BaseModel):
    attention_revision: int = Field(ge=0)


@router.patch("/{operation_id}/read")
async def read_one(
    operation_id: str, data: ReadOne, user=Depends(require_user), session=Depends(get_session)
):
    await owned(session, user.id, operation_id)
    observed = case(
        (Operation.attention_revision < data.attention_revision, Operation.attention_revision),
        else_=data.attention_revision,
    )
    await session.execute(
        update(Operation)
        .where(
            Operation.id == operation_id,
            Operation.user_id == user.id,
        )
        .values(
            read_revision=case(
                (Operation.read_revision < observed, observed), else_=Operation.read_revision
            )
        )
    )
    operation = await session.get(Operation, operation_id, populate_existing=True)
    changed(session, operation)
    await commit_and_publish(session)
    return serialize(operation)
