"""FastAPI 应用入口。"""

import asyncio
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import router
from .calendar_service import calendar_refresh_loop
from .calendar_service import router as calendar_router
from .collections import router as collection_router
from .config import settings
from .database import SessionFactory, init_database
from .download_queue import download_queue_loop
from .library import router as library_router
from .library_scan import library_scan_loop
from .library_scan import router as library_scan_router
from .notification_api import router as notification_router
from .notifications import recover_operations
from .playback.metadata import prewarmer
from .playback.probe import shutdown_probes
from .playback.router import router as playback_media_router
from .playback.session_router import router as playback_session_router
from .playback.sessions import manager as playback_manager
from .review import router as review_router
from .subscription_settings import router as subscription_router
from .subscription_settings import subscription_refresh_loop
from .tmdb_settings import router as tmdb_settings_router


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """在开始接收请求前准备数据库。"""
    await init_database()
    await playback_manager.start()
    prewarmer.start()
    async with SessionFactory() as session:
        await recover_operations(session)
    refresh_task = asyncio.create_task(subscription_refresh_loop())
    calendar_task = asyncio.create_task(calendar_refresh_loop())
    download_task = asyncio.create_task(download_queue_loop())
    image_task = asyncio.create_task(library_scan_loop())
    try:
        yield
    finally:
        await playback_manager.shutdown()
        await prewarmer.shutdown()
        await shutdown_probes()
        image_task.cancel()
        with suppress(asyncio.CancelledError):
            await image_task
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
app.include_router(collection_router)
app.include_router(notification_router)
app.include_router(review_router)
app.include_router(library_router)
app.include_router(library_scan_router)
app.include_router(subscription_router)
app.include_router(tmdb_settings_router)
app.include_router(calendar_router)
app.include_router(playback_media_router)
app.include_router(playback_session_router, prefix="/api/v1")


if settings.frontend_dist_path:
    from .web import mount_frontend

    mount_frontend(app, settings.frontend_dist_path)
else:

    @app.get("/")
    async def root() -> dict[str, str]:
        return {"name": "Mooncell", "docs": "/docs", "health": "/api/v1/health"}
