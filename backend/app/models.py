"""Mooncell 的 SQLite 持久化模型。"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    JSON,
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
    """Mikan 或标准 RSS/Atom 订阅源及其条件请求缓存信息。"""

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
    status: Mapped[str] = mapped_column(String(24), default="pending")
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    scraped_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    source: Mapped[FeedSource] = relationship(back_populates="artwork")


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
        ForeignKey("feed_items.id", ondelete="CASCADE"), unique=True,
    )
    info_hash: Mapped[str] = mapped_column(String(40), unique=True)
    downloader_id: Mapped[int] = mapped_column(ForeignKey("downloader_configs.id"))
    state: Mapped[str] = mapped_column(String(24), default="queued")
    target_root: Mapped[str] = mapped_column(Text)
    title: Mapped[str] = mapped_column(Text)
    season: Mapped[int] = mapped_column(Integer)
    plan: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)


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
