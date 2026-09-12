"""FastAPI 应用入口。"""

import asyncio
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import router
from .calendar_service import calendar_refresh_loop
from .calendar_service import router as calendar_router
from .config import settings
from .database import init_database
from .download_queue import download_queue_loop
from .library import router as library_router
from .subscription_settings import router as subscription_router
from .subscription_settings import subscription_refresh_loop


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """在开始接收请求前准备数据库。"""
    await init_database()
    refresh_task = asyncio.create_task(subscription_refresh_loop())
    calendar_task = asyncio.create_task(calendar_refresh_loop())
    download_task = asyncio.create_task(download_queue_loop())
    try:
        yield
    finally:
        download_task.cancel()
        with suppress(asyncio.CancelledError):
            await download_task
        refresh_task.cancel()
        with suppress(asyncio.CancelledError):
            await refresh_task
        calendar_task.cancel()
        with suppress(asyncio.CancelledError):
            await calendar_task


app = FastAPI(
    title="Mooncell API",
    description="RSS anime automation and media organization service",
    version="0.1.0",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.origin_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE"],
    allow_headers=["*"],
)
app.include_router(router)
app.include_router(library_router)
app.include_router(subscription_router)
app.include_router(calendar_router)


@app.get("/")
async def root() -> dict[str, str]:
    return {"name": "Mooncell", "docs": "/docs", "health": "/api/v1/health"}
