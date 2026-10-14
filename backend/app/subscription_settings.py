"""订阅专用网络设置与自动刷新。"""
import asyncio
import logging
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, HttpUrl
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from .database import SessionFactory, get_session
from .dependencies import require_user
from .models import FeedSource, SubscriptionSettings

router = APIRouter(prefix="/api/v1/settings", dependencies=[Depends(require_user)])
logger = logging.getLogger(__name__)


class SubscriptionOptions(BaseModel):
    proxy_url: HttpUrl | None = None
    refresh_interval_minutes: int = Field(default=5, ge=1, le=1440)


async def get_options(session: AsyncSession) -> SubscriptionOptions:
    saved = await session.get(SubscriptionSettings, 1)
    return SubscriptionOptions(
        proxy_url=saved.proxy_url,
        refresh_interval_minutes=saved.refresh_interval_minutes,
    ) if saved else SubscriptionOptions()


@router.get("/subscriptions", response_model=SubscriptionOptions)
async def read_options(session: AsyncSession = Depends(get_session)):
    return await get_options(session)


@router.patch("/subscriptions", response_model=SubscriptionOptions)
async def save_options(data: SubscriptionOptions, session: AsyncSession = Depends(get_session)):
    saved = await session.get(SubscriptionSettings, 1)
    if saved is None:
        saved = SubscriptionSettings(id=1)
        session.add(saved)
    saved.proxy_url = str(data.proxy_url) if data.proxy_url else None
    saved.refresh_interval_minutes = data.refresh_interval_minutes
    await session.execute(update(FeedSource).values(
        refresh_interval_minutes=data.refresh_interval_minutes,
    ))
    await session.commit()
    return data


def is_due(source: FeedSource, minutes: int, now: datetime) -> bool:
    checked = source.last_checked_at
    if checked is None:
        return True
    if checked.tzinfo is None:
        checked = checked.replace(tzinfo=UTC)
    return now - checked >= timedelta(minutes=minutes)


async def refresh_due_feeds() -> None:
    from .events import _redact
    from .rss_service import FeedRefreshService, describe_rss_exception

    async with SessionFactory() as session:
        ids = list(await session.scalars(select(FeedSource.id).where(FeedSource.active.is_(True))))
    for source_id in ids:
        async with SessionFactory() as session:
            source = await session.get(FeedSource, source_id)
            if source and source.active and is_due(
                source, source.refresh_interval_minutes, datetime.now(UTC)
            ):
                try:
                    await FeedRefreshService(session).refresh(source)
                except Exception as exc:
                    logger.warning("订阅 %s 自动刷新失败：%s", source_id,
                                   _redact(describe_rss_exception(exc)))


async def subscription_refresh_loop() -> None:
    # 先让页面读取本地数据，启动宽限期仅影响自动刷新。
    await asyncio.sleep(30)
    while True:
        try:
            await refresh_due_feeds()
        except Exception:
            logger.exception("订阅自动刷新检查失败")
        await asyncio.sleep(15)
