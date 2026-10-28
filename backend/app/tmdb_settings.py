"""TMDB 凭据加密持久化；读取接口仅返回配置状态。"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from .database import SessionFactory, get_session
from .dependencies import require_user
from .models import TmdbSettings
from .security import decrypt_secret, encrypt_secret

router = APIRouter(prefix="/api/v1/settings", dependencies=[Depends(require_user)])


class TmdbOptionsRead(BaseModel):
    read_access_token_configured: bool
    api_key_configured: bool


class TmdbOptionsUpdate(BaseModel):
    # 省略或 null 保留原值，空字符串清除。
    read_access_token: str | None = Field(default=None, max_length=4096)
    api_key: str | None = Field(default=None, max_length=256)

    @field_validator("read_access_token", "api_key")
    @classmethod
    def normalize(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if any(character.isspace() for character in value):
            raise ValueError("凭据不能包含空白字符")
        return value


def configured(saved: TmdbSettings | None) -> TmdbOptionsRead:
    return TmdbOptionsRead(
        read_access_token_configured=bool(saved and saved.encrypted_read_access_token),
        api_key_configured=bool(saved and saved.encrypted_api_key),
    )


@router.get("/tmdb", response_model=TmdbOptionsRead)
async def read_options(session: AsyncSession = Depends(get_session)):
    return configured(await session.get(TmdbSettings, 1))


@router.patch("/tmdb", response_model=TmdbOptionsRead)
async def save_options(data: TmdbOptionsUpdate, session: AsyncSession = Depends(get_session)):
    saved = await session.get(TmdbSettings, 1)
    if saved is None:
        saved = TmdbSettings(id=1)
        session.add(saved)
    for field in ("read_access_token", "api_key"):
        value = getattr(data, field)
        if value is not None:
            setattr(saved, f"encrypted_{field}", encrypt_secret(value))
    await session.commit()
    return configured(saved)


async def get_credentials() -> tuple[str | None, str | None]:
    async with SessionFactory() as session:
        saved = await session.get(TmdbSettings, 1)
        if saved is None:
            return None, None
        return (
            decrypt_secret(saved.encrypted_read_access_token),
            decrypt_secret(saved.encrypted_api_key),
        )
