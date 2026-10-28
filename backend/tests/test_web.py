"""验证单镜像部署的前端路由不会覆盖 API 或隐藏缺失资源。"""

import httpx
import pytest
from fastapi import FastAPI

from app.web import mount_frontend


@pytest.mark.asyncio
async def test_frontend_routes_and_missing_resources(tmp_path):
    (tmp_path / "index.html").write_text("<html>Mooncell</html>", encoding="utf-8")
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "app.js").write_text("console.log('mooncell')", encoding="utf-8")
    app = FastAPI()

    @app.get("/api/v1/health")
    async def health():
        return {"status": "ok"}

    mount_frontend(app, str(tmp_path))
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        for path in ["/", "/shows/42", "/watch/42"]:
            response = await client.get(path)
            assert response.status_code == 200
            assert response.text == "<html>Mooncell</html>"
            assert response.headers["content-type"].startswith("text/html")
        asset = await client.get("/assets/app.js")
        assert asset.status_code == 200
        assert "console.log" in asset.text
        assert (await client.get("/api/v1/health")).json() == {"status": "ok"}
        for path in ["/api", "/api/v1/missing", "/assets/missing.js", "/missing.webp"]:
            assert (await client.get(path)).status_code == 404
        assert (await client.post("/shows/42")).status_code == 405
