from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import create_async_engine

from app import database
from app.database import Base


async def test_old_database_keeps_jobs_and_adds_retry_columns(monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    monkeypatch.setattr(database, "engine", engine)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
            await connection.execute(text("ALTER TABLE download_jobs DROP COLUMN retry_attempts"))
            await connection.execute(text("ALTER TABLE download_jobs DROP COLUMN next_retry_at"))
            await connection.execute(text(
                "INSERT INTO download_jobs "
                "(id, item_id, info_hash, downloader_id, state, target_root, title, season, plan) "
                "VALUES (7, 1, 'abc', 1, 'organizing', '/media', '测试番名', 1, '{}')"
            ))
        # 兼容更新必须可重复执行，且不清空既有任务。
        await database.init_database()
        await database.init_database()
        async with engine.connect() as connection:
            columns = await connection.run_sync(
                lambda conn: inspect(conn).get_columns("download_jobs")
            )
            assert {"retry_attempts", "next_retry_at"} <= {col["name"] for col in columns}
            row = (await connection.execute(text(
                "SELECT state, plan, retry_attempts, next_retry_at FROM download_jobs WHERE id=7"
            ))).one()
            assert tuple(row) == ("organizing", "{}", 0, None)
    finally:
        await engine.dispose()
