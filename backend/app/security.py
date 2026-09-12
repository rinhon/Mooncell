"""密码、会话令牌和下载器凭据的安全处理。"""

import base64
import hashlib
import hmac
import secrets
from datetime import UTC, datetime, timedelta

from cryptography.fernet import Fernet
from sqlalchemy.ext.asyncio import AsyncSession

from .config import settings
from .models import UserSession

PASSWORD_ITERATIONS = 600_000


def hash_password(password: str) -> str:
    """使用独立随机盐和 PBKDF2 保存密码，绝不保存明文。"""
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS)
    return "pbkdf2_sha256${}${}${}".format(
        PASSWORD_ITERATIONS,
        base64.urlsafe_b64encode(salt).decode("ascii"),
        base64.urlsafe_b64encode(digest).decode("ascii"),
    )


def verify_password(password: str, encoded: str) -> bool:
    """以常量时间比较密码摘要，避免泄露匹配进度。"""
    try:
        algorithm, iterations, salt_text, digest_text = encoded.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        salt = base64.urlsafe_b64decode(salt_text)
        expected = base64.urlsafe_b64decode(digest_text)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, int(iterations))
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def token_hash(token: str) -> str:
    """数据库只存会话令牌摘要；原始令牌仅存在于 HttpOnly Cookie。"""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


async def create_user_session(session: AsyncSession, user_id: int) -> str:
    """创建有有效期的登录会话，并把仅此一次可见的原始令牌返回给调用方。"""
    raw_token = secrets.token_urlsafe(32)
    expires_at = datetime.now(UTC) + timedelta(days=settings.session_days)
    session.add(
        UserSession(user_id=user_id, token_hash=token_hash(raw_token), expires_at=expires_at)
    )
    await session.flush()
    return raw_token


def _fernet() -> Fernet:
    # 用部署密钥派生固定长度的 Fernet 密钥，避免数据库泄露时暴露下载器密码。
    key = hashlib.sha256(settings.secret_key.encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def encrypt_secret(value: str | None) -> str | None:
    """加密 qBittorrent 密码或 aria2 RPC Secret。"""
    if not value:
        return None
    return _fernet().encrypt(value.encode("utf-8")).decode("ascii")


def decrypt_secret(value: str | None) -> str | None:
    """仅在调用下载器 API 前临时解密凭据。"""
    if not value:
        return None
    return _fernet().decrypt(value.encode("ascii")).decode("utf-8")
