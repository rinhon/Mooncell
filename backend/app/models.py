"""Mooncell 的 SQLite 持久化模型。"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def utcnow() -> datetime:
    return datetime.now(UTC)


class TmdbSettings(Base):
    __tablename__ = "tmdb_settings"
    id: Mapped[int] = mapped_column(primary_key=True, default=1)
    encrypted_read_access_token: Mapped[str | None] = mapped_column(Text, nullable=True)
    encrypted_api_key: Mapped[str | None] = mapped_column(Text, nullable=True)


class SubscriptionSettings(Base):
    __tablename__ = "subscription_settings"
    id: Mapped[int] = mapped_column(primary_key=True, default=1)
    proxy_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    refresh_interval_minutes: Mapped[int] = mapped_column(Integer, default=5)


class CalendarFavorite(Base):
    __tablename__ = "calendar_favorites"
    season: Mapped[str] = mapped_column(String(6), primary_key=True)
    item_id: Mapped[int] = mapped_column(Integer, primary_key=True)


class LibrarySettings(Base):
    """媒体库保存路径，独立于下载器连接配置持久化。"""

    __tablename__ = "library_settings"
    id: Mapped[int] = mapped_column(primary_key=True, default=1)
    library_root: Mapped[str] = mapped_column(Text)


class User(Base):
    """局域网部署中的唯一管理员账户。"""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True)
    password_hash: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    sessions: Mapped[list[UserSession]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )


class UserSession(Base):
    """可撤销、可过期的浏览器登录会话。"""

    __tablename__ = "user_sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    user: Mapped[User] = relationship(back_populates="sessions")


class FeedSource(Base):
    """RSS/Atom 订阅源或单次磁力合集，以及各自的连接状态。"""

    __tablename__ = "feed_sources"

    season: Mapped[int | None] = mapped_column(Integer, nullable=True)

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(160))
    url: Mapped[str] = mapped_column(Text, unique=True)
    kind: Mapped[str] = mapped_column(String(32), default="standard")
    excluded_keywords: Mapped[list[str]] = mapped_column(JSON, default=list, server_default="[]")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    refresh_interval_minutes: Mapped[int] = mapped_column(Integer, default=5)
    etag: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_modified: Mapped[str | None] = mapped_column(Text, nullable=True)
    connection_status: Mapped[str] = mapped_column(String(24), default="unknown")
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )

    items: Mapped[list[FeedItem]] = relationship(
        back_populates="source", cascade="all, delete-orphan"
    )
    show_metadata: Mapped[ShowMetadata | None] = relationship(
        back_populates="source", cascade="all, delete-orphan", lazy="selectin", uselist=False
    )
    artwork: Mapped[ShowArtwork | None] = relationship(
        back_populates="source", cascade="all, delete-orphan", lazy="selectin", uselist=False
    )


class ShowMetadata(Base):
    """用户确认后的 TMDB 刮削结果；与一个 RSS 订阅一一对应。"""

    __tablename__ = "show_metadata"

    id: Mapped[int] = mapped_column(primary_key=True)
    source_id: Mapped[int] = mapped_column(
        ForeignKey("feed_sources.id", ondelete="CASCADE"), unique=True, index=True
    )
    tmdb_id: Mapped[int] = mapped_column(Integer, index=True)
    media_type: Mapped[str] = mapped_column(String(16))
    title: Mapped[str] = mapped_column(String(240))
    overview: Mapped[str | None] = mapped_column(Text, nullable=True)
    poster_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    release_date: Mapped[str | None] = mapped_column(String(32), nullable=True)
    genres_json: Mapped[str] = mapped_column(Text, default="[]")
    episode_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    rating: Mapped[float | None] = mapped_column(Float, nullable=True)
    vote_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    href: Mapped[str] = mapped_column(Text)
    scraped_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    source: Mapped[FeedSource] = relationship(back_populates="show_metadata")


class ShowArtwork(Base):
    """存放在番剧目录中的 poster、fanart 与 clearlogo 刮削结果。"""

    __tablename__ = "show_artwork"

    id: Mapped[int] = mapped_column(primary_key=True)
    source_id: Mapped[int] = mapped_column(
        ForeignKey("feed_sources.id", ondelete="CASCADE"), unique=True, index=True
    )
    directory: Mapped[str] = mapped_column(Text)
    poster_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    fanart_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    clearlogo_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    file_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(String(24), default="pending")
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    scraped_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    source: Mapped[FeedSource] = relationship(back_populates="artwork")


class EpisodeThumbnail(Base):
    """按真实视频相对路径关联的本地单集缩略图。"""

    __tablename__ = "episode_thumbnails"
    __table_args__ = (UniqueConstraint("source_id", "video_path"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    source_id: Mapped[int] = mapped_column(
        ForeignKey("feed_sources.id", ondelete="CASCADE"),
        index=True,
    )
    video_path: Mapped[str] = mapped_column(Text)
    image_path: Mapped[str] = mapped_column(Text)
    file_version: Mapped[str] = mapped_column(String(64))


class MediaFile(Base):
    """文件版本不可变的媒体身份；替换或改名后使用新的媒体 ID。"""

    __tablename__ = "media_files"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    source_id: Mapped[int] = mapped_column(
        ForeignKey("feed_sources.id", ondelete="CASCADE"),
        index=True,
    )
    relative_path: Mapped[str] = mapped_column(Text)
    file_version: Mapped[str] = mapped_column(String(64))
    size: Mapped[int] = mapped_column(Integer)
    mtime_ns: Mapped[str] = mapped_column(String(32))
    probe_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class PlaybackProgress(Base):
    __tablename__ = "playback_progress"
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    media_id: Mapped[str] = mapped_column(
        ForeignKey("media_files.id", ondelete="CASCADE"),
        primary_key=True,
    )
    position: Mapped[float] = mapped_column(Float, default=0)
    duration: Mapped[float] = mapped_column(Float, default=0)
    completed: Mapped[bool] = mapped_column(Boolean, default=False)
    session_id: Mapped[str] = mapped_column(String(64))
    session_created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    generation: Mapped[int] = mapped_column(Integer)
    sequence: Mapped[int] = mapped_column(Integer)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class FeedItem(Base):
    """RSS 中发现的一条发布；原始信息和解析结果同时保留以便审计。"""

    __tablename__ = "feed_items"
    __table_args__ = (
        UniqueConstraint("source_id", "fingerprint", name="uq_feed_items_source_fingerprint"),
        Index("idx_feed_items_source_published", "source_id", "published_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    source_id: Mapped[int] = mapped_column(
        ForeignKey("feed_sources.id", ondelete="CASCADE"), index=True
    )
    guid: Mapped[str | None] = mapped_column(Text, nullable=True)
    title: Mapped[str] = mapped_column(Text)
    detail_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    download_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    info_hash: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    fingerprint: Mapped[str] = mapped_column(String(64))
    parse_status: Mapped[str] = mapped_column(String(24), default="parsed")
    parse_data: Mapped[str] = mapped_column(Text)
    discovered_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    source: Mapped[FeedSource] = relationship(back_populates="items")


class DownloaderConfig(Base):
    """qBittorrent/aria2 连接和宿主机—容器路径映射配置。"""

    __tablename__ = "downloader_configs"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    kind: Mapped[str] = mapped_column(String(24))
    base_url: Mapped[str] = mapped_column(Text)
    username: Mapped[str | None] = mapped_column(String(160), nullable=True)
    encrypted_secret: Mapped[str | None] = mapped_column(Text, nullable=True)
    verify_tls: Mapped[bool] = mapped_column(Boolean, default=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    remote_download_root: Mapped[str | None] = mapped_column(Text, nullable=True)
    local_download_root: Mapped[str | None] = mapped_column(Text, nullable=True)
    library_root: Mapped[str | None] = mapped_column(Text, nullable=True)
    organize_strategy: Mapped[str] = mapped_column(String(32), default="downloader_managed")
    connection_status: Mapped[str] = mapped_column(String(24), default="unknown")
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


class DownloadJob(Base):
    """持久化投递与整理进度，重启后继续等待磁力元数据。"""

    __tablename__ = "download_jobs"
    id: Mapped[int] = mapped_column(primary_key=True)
    item_id: Mapped[int] = mapped_column(
        ForeignKey("feed_items.id", ondelete="CASCADE"),
        unique=True,
    )
    info_hash: Mapped[str] = mapped_column(String(40), unique=True)
    downloader_id: Mapped[int] = mapped_column(ForeignKey("downloader_configs.id"))
    state: Mapped[str] = mapped_column(String(24), default="queued")
    target_root: Mapped[str] = mapped_column(Text)
    title: Mapped[str] = mapped_column(Text)
    season: Mapped[int] = mapped_column(Integer)
    plan: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    retry_attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    next_retry_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class DomainEvent(Base):
    """持久化事件日志，用于 SSE 断线重连后补发遗漏事件。"""

    __tablename__ = "domain_events"
    __table_args__ = (Index("idx_domain_events_created", "created_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    event_type: Mapped[str] = mapped_column(String(80), index=True)
    resource_type: Mapped[str | None] = mapped_column(String(80), nullable=True)
    resource_id: Mapped[str | None] = mapped_column(String(80), nullable=True)
    payload: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class BackgroundOperation(Base):
    """一次用户操作，也是提醒中心中唯一的一条记录。"""

    __tablename__ = "background_operations"
    __table_args__ = (Index("idx_operations_user_updated", "user_id", "updated_at", "id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(32))
    source_id: Mapped[int | None] = mapped_column(
        ForeignKey("feed_sources.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    source_name: Mapped[str] = mapped_column(String(160))
    status: Mapped[str] = mapped_column(String(24), default="queued")
    total_count: Mapped[int] = mapped_column(Integer, default=0)
    completed_count: Mapped[int] = mapped_column(Integer, default=0)
    summary: Mapped[str] = mapped_column(Text, default="已排队，等待后台处理")
    error_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    context: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    attention_revision: Mapped[int] = mapped_column(Integer, default=0)
    read_revision: Mapped[int] = mapped_column(Integer, default=0)
    attention_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    attention_key: Mapped[str | None] = mapped_column(Text, nullable=True)


class BackgroundOperationItem(Base):
    __tablename__ = "background_operation_items"
    __table_args__ = (UniqueConstraint("operation_id", "download_job_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    operation_id: Mapped[str] = mapped_column(
        ForeignKey("background_operations.id", ondelete="CASCADE"),
        index=True,
    )
    download_job_id: Mapped[int | None] = mapped_column(
        ForeignKey("download_jobs.id", ondelete="SET NULL"),
        nullable=True,
    )
    migration_token: Mapped[str] = mapped_column(String(32), unique=True)
    status: Mapped[str] = mapped_column(String(24), default="queued")
    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
