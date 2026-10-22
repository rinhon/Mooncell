"""单镜像部署的前端静态文件与浏览器路由回退。"""

from pathlib import PurePosixPath

from fastapi import FastAPI
from starlette.exceptions import HTTPException
from starlette.staticfiles import StaticFiles
from starlette.types import Scope


class FrontendFiles(StaticFiles):
    async def get_response(self, path: str, scope: Scope):
        path = path.replace("\\", "/")
        # 未匹配的 API 必须保留 404，不能返回前端 HTML。
        if path == "api" or path.startswith("api/"):
            raise HTTPException(status_code=404)
        try:
            return await super().get_response(path, scope)
        except HTTPException as exc:
            if exc.status_code != 404 or PurePosixPath(path).suffix:
                raise
            return await super().get_response("index.html", scope)


def mount_frontend(app: FastAPI, directory: str) -> None:
    """在 API 路由之后挂载构建产物，支持直接访问和刷新前端子路由。"""
    app.mount("/", FrontendFiles(directory=directory, html=True), name="frontend")
