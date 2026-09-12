"""异步数据库引擎、会话生命周期和首次建表逻辑。"""

from collections.abc import AsyncIterator
from pathlib import Path

from sqlalchemy import event, inspect, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from .config import settings


class Base(DeclarativeBase):
    pass


engine = create_async_engine(settings.database_url, future=True)
SessionFactory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


@event.listens_for(engine.sync_engine, "connect")
def configure_sqlite(dbapi_connection, _connection_record) -> None:
    """为每个 SQLite 连接启用外键，并在短暂锁表时等待而不是立即失败。"""
    if settings.database_url.startswith("sqlite"):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA busy_timeout=5000")
        cursor.close()


async def init_database() -> None:
    """确保数据目录存在，并在服务启动时创建尚不存在的数据表。"""
    if settings.database_url.startswith("sqlite"):
        Path("data").mkdir(parents=True, exist_ok=True)
    # 必须导入模型，SQLAlchemy 才能在 metadata 中发现所有表。
    from . import models  # noqa: F401

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
        columns = await connection.run_sync(
            lambda sync_connection: inspect(sync_connection).get_columns("feed_sources")
        )
        if not any(column["name"] == "season" for column in columns):
            await connection.execute(text("ALTER TABLE feed_sources ADD COLUMN season INTEGER"))
        if not any(column["name"] == "excluded_keywords" for column in columns):
            await connection.execute(text(
                "ALTER TABLE feed_sources ADD COLUMN excluded_keywords JSON NOT NULL DEFAULT '[]'"
            ))


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI 依赖：一个请求对应一个异步数据库会话。"""
    async with SessionFactory() as session:
        yield session
