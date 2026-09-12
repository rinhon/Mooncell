"""FastAPI 的认证依赖。"""

from datetime import UTC, datetime

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import settings
from .database import get_session
from .models import User, UserSession
from .security import token_hash


async def optional_user(
    request: Request, session: AsyncSession = Depends(get_session)
) -> User | None:
    """尝试从 Cookie 恢复用户；无效或过期会话按匿名处理。"""
    raw_token = request.cookies.get(settings.session_cookie_name)
    if not raw_token:
        return None
    result = await session.execute(
        select(User)
        .join(UserSession)
        .where(
            UserSession.token_hash == token_hash(raw_token),
            UserSession.expires_at > datetime.now(UTC),
        )
    )
    return result.scalar_one_or_none()


async def require_user(user: User | None = Depends(optional_user)) -> User:
    """保护管理 API，未登录时统一返回 401。"""
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="请先登录")
    return user
