FROM ghcr.io/astral-sh/uv:0.10-python3.12-alpine AS builder

WORKDIR /app
ENV UV_LINK_MODE=copy

COPY pyproject.toml ./
RUN uv sync --no-dev --no-install-project

FROM python:3.12-alpine AS runtime

RUN apk add --no-cache imagemagick && addgroup -S mooncell && adduser -S mooncell -G mooncell
WORKDIR /app

COPY --from=builder /app/.venv /app/.venv
COPY app ./app

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1

RUN mkdir -p /app/data && chown -R mooncell:mooncell /app
USER mooncell

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8000/api/v1/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
