"""应用配置：统一从环境变量和根目录 `.env` 读取运行参数。"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Mooncell 运行时配置；环境变量统一使用 `MOONCELL_` 前缀。"""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="MOONCELL_",
        extra="ignore",
    )

    app_name: str = "Mooncell"
    environment: str = "development"
    frontend_dist_path: str | None = None
    database_url: str = "sqlite+aiosqlite:///./data/mooncell.db"
    secret_key: str = "development-only-change-me"
    session_cookie_name: str = "mooncell_session"
    session_cookie_secure: bool = False
    session_days: int = 30
    allowed_origins: str = "http://localhost:5173,http://localhost:3000"
    rss_timeout_seconds: float = 20.0
    rss_user_agent: str = "Mooncell/0.1 (+self-hosted RSS reader)"
    tmdb_base_url: str = "https://www.themoviedb.org"
    tmdb_language: str = "zh-CN"
    tmdb_timeout_seconds: float = 20.0
    tmdb_user_agent: str = "Mozilla/5.0 (compatible; Mooncell/0.1; +self-hosted)"
    media_library_root: str = "./data/library"
    calendar_cache_path: str = "./data/calendar"
    library_scan_interval_seconds: int = 0
    playback_ffmpeg: str = "ffmpeg"
    playback_ffprobe: str = "ffprobe"
    playback_cache_path: str = "./data/playback"
    playback_encoder: str = "libx264"
    playback_threads: int = 2
    playback_max_sessions: int = 1
    playback_session_quota_mb: int = 512
    playback_global_quota_mb: int = 4096
    playback_min_free_mb: int = 512
    playback_probe_timeout_seconds: float = 20.0

    @property
    def origin_list(self) -> list[str]:
        """把逗号分隔的 CORS 白名单转换为 FastAPI 可使用的列表。"""
        return [origin.strip() for origin in self.allowed_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    """缓存配置实例，避免每个请求重复读取环境变量和 `.env`。"""
    return Settings()


settings = get_settings()
