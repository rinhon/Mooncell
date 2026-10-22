FROM node:22-alpine AS frontend-builder

WORKDIR /build/frontend
RUN corepack enable
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend/ ./
RUN pnpm build

FROM ghcr.io/astral-sh/uv:0.10-python3.12-alpine AS backend-builder

WORKDIR /app
ENV UV_LINK_MODE=copy
RUN apk add --no-cache gcc musl-dev linux-headers
COPY backend/pyproject.toml ./
RUN uv sync --no-dev --no-install-project

FROM python:3.12-alpine AS runtime

RUN apk add --no-cache imagemagick ffmpeg libstdc++ tzdata \
    && addgroup -S mooncell && adduser -S mooncell -G mooncell
WORKDIR /app
COPY --from=backend-builder /app/.venv /app/.venv
COPY backend/app ./app
COPY --from=frontend-builder /build/frontend/dist ./static

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    MOONCELL_ENVIRONMENT=production \
    MOONCELL_FRONTEND_DIST_PATH=/app/static \
    MOONCELL_DATABASE_URL=sqlite+aiosqlite:////app/data/mooncell.db \
    MOONCELL_MEDIA_LIBRARY_ROOT=/library \
    MOONCELL_PLAYBACK_CACHE_PATH=/app/data/playback

RUN mkdir -p /app/data /downloads /library \
    && chown -R mooncell:mooncell /app /downloads /library
USER mooncell

EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8000/api/v1/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
