"""HTTP API 的输入、输出和领域数据结构。"""

from __future__ import annotations

import re
from datetime import datetime
from pathlib import PureWindowsPath
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, field_validator, model_validator


class ApiMessage(BaseModel):
    message: str


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    service: str = "mooncell-backend"
    version: str = "0.1.0"


class AuthStatus(BaseModel):
    initialized: bool
    authenticated: bool
    username: str | None = None


class Credentials(BaseModel):
    username: str = Field(default="admin", min_length=1, max_length=64)
    password: str = Field(min_length=10, max_length=256)


class TmdbSearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=240)


class TmdbCandidate(BaseModel):
    tmdb_id: int
    media_type: Literal["tv", "movie"]
    title: str
    original_title: str | None = None
    release_date: str | None = None
    overview: str | None = None
    poster_url: str | None = None
    href: str


class TmdbSelection(BaseModel):
    tmdb_id: int = Field(gt=0)
    media_type: Literal["tv", "movie"]


class TmdbMetadata(TmdbSelection):
    title: str
    overview: str | None = None
    poster_url: str | None = None
    release_date: str | None = None
    genres: list[str] = Field(default_factory=list)
    episode_count: int | None = None
    rating: float | None = None
    vote_count: int | None = None
    href: str


class ShowMetadataRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    tmdb_id: int
    media_type: str
    title: str
    overview: str | None
    poster_url: str | None
    release_date: str | None
    episode_count: int | None
    rating: float | None
    vote_count: int | None
    href: str


class ShowRead(BaseModel):
    background_operation_ids: list[str] = Field(default_factory=list)
    artwork_version: str | None = None
    artwork_versions: dict[str, str] = Field(default_factory=dict)
    tmdb_url: str | None = None
    id: int
    name: str
    active: bool
    created_at: datetime
    tmdb_id: int | None = None
    media_type: str | None = None
    metadata_title: str | None = None
    overview: str | None = None
    release_date: str | None = None
    episode_count: int | None = None
    rating: float | None = None
    poster_url: str | None = None
    discovered_items: int = 0
    artwork_status: str = "missing"
    poster_ready: bool = False
    fanart_ready: bool = False
    clearlogo_ready: bool = False


class ArtworkAppearance(BaseModel):
    background: Literal["light", "dark"]


class FeedCreate(BaseModel):
    excluded_keywords: list[str] = Field(default_factory=lambda: ["720"], max_length=20)

    @field_validator("excluded_keywords")
    @classmethod
    def normalize_excluded_keywords(cls, values: list[str]) -> list[str]:
        keywords: dict[str, str] = {}
        for value in values:
            keyword = value.strip()
            if len(keyword) > 100:
                raise ValueError("排除关键词不能超过 100 个字符")
            if keyword:
                keywords.setdefault(keyword.casefold(), keyword)
        return list(keywords.values())

    # 名称可省略；后端会读取 RSS 频道标题生成，避免信任前端字符串处理。
    season: int | None = Field(default=None, ge=0, le=99)
    name: str | None = Field(default=None, min_length=1, max_length=160)
    url: HttpUrl
    kind: Literal["mikan", "standard"] = "standard"
    active: bool = True
    refresh_interval_minutes: int = Field(default=5, ge=1, le=1440)
    tmdb: TmdbSelection | None = None


class FeedUpdate(BaseModel):
    tmdb: TmdbSelection | None = None
    excluded_keywords: list[str] | None = Field(default=None, max_length=20)
    season: int | None = Field(default=None, ge=0, le=99)
    name: str | None = Field(default=None, min_length=1, max_length=160)
    url: HttpUrl | None = None
    kind: Literal["mikan", "standard"] | None = None
    active: bool | None = None
    refresh_interval_minutes: int | None = Field(default=None, ge=1, le=1440)

    @model_validator(mode="before")
    @classmethod
    def reject_null_fields(cls, values):
        if isinstance(values, dict):
            for key in (
                "name",
                "url",
                "kind",
                "active",
                "refresh_interval_minutes",
                "excluded_keywords",
            ):
                if key in values and values[key] is None:
                    raise ValueError(f"{key} 不能为 null")
        return values

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        name = value.strip()
        if not name:
            raise ValueError("订阅名称不能为空")
        return name

    @field_validator("excluded_keywords")
    @classmethod
    def normalize_keywords(cls, values: list[str]) -> list[str]:
        return FeedCreate.normalize_excluded_keywords(values)


class FeedRead(BaseModel):
    background_operation_ids: list[str] = Field(default_factory=list)
    model_config = ConfigDict(from_attributes=True)
    excluded_keywords: list[str] = Field(default_factory=list)

    id: int
    season: int | None = Field(default=None, ge=0, le=99)
    name: str
    url: str
    kind: str
    active: bool
    refresh_interval_minutes: int
    connection_status: str
    last_checked_at: datetime | None
    last_error: str | None
    created_at: datetime
    show_metadata: ShowMetadataRead | None = None


class FeedBatchStopRequest(BaseModel):
    source_ids: list[Annotated[int, Field(gt=0, strict=True)]] = Field(min_length=1, max_length=100)


class FeedBatchStopResult(BaseModel):
    items: list[FeedRead]
    stopped_count: int
    already_stopped_count: int


class FeedInspectRequest(BaseModel):
    url: HttpUrl


class FeedInspectResult(BaseModel):
    raw_title: str
    name: str
    kind: Literal["mikan", "standard"]
    entries: int


class CollectionFileOverride(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str = Field(min_length=1, max_length=4096)
    episode: float | None = Field(default=None, ge=0, allow_inf_nan=False, strict=True)
    # 兼容此前持久化的覆盖记录；新建合集不接受改名，整理计划也不再采用此值。
    filename: str | None = Field(default=None, min_length=1, max_length=255)

    @field_validator("path")
    @classmethod
    def validate_path(cls, value):
        normalized = value.replace("\\", "/")
        if (
            PureWindowsPath(value).drive
            or ":" in normalized
            or re.search(r"[\x00-\x1f\x7f]", normalized)
            or any(part in {"", ".", ".."} for part in normalized.split("/"))
        ):
            raise ValueError("文件路径无效，请重新解析磁力")
        return normalized

    @field_validator("filename")
    @classmethod
    def validate_filename(cls, value):
        if value is not None and (
            value.startswith(".")
            or value.rstrip(" .") != value
            or re.search(r'[\\/:<>"|?*\x00-\x1f\x7f]', value)
            or PureWindowsPath(value).is_reserved()
            or len(value.encode("utf-8")) > 255
        ):
            raise ValueError("文件名不能包含路径、保留名称或无效字符")
        return value

    @model_validator(mode="after")
    def require_change(self):
        if self.episode is None and self.filename is None:
            raise ValueError("请填写要修改的集数")
        return self


class ParsedRelease(BaseModel):
    raw_title: str
    title: str | None = None
    release_group: str | None = None
    media_type: Literal[
        "episode", "movie", "ova", "oad", "special", "pv", "opening", "ending", "unknown"
    ] = "unknown"
    release_kind: Literal["single", "range", "batch", "collection"] = "single"
    season: int | None = None
    episode_start: float | None = None
    episode_end: float | None = None
    revision: int = 1
    resolution: str | None = None
    sources: list[str] = Field(default_factory=list)
    subtitle_languages: list[str] = Field(default_factory=list)
    video_codecs: list[str] = Field(default_factory=list)
    audio_codecs: list[str] = Field(default_factory=list)
    container: str | None = None
    confidence: float = Field(ge=0, le=1)
    evidence: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    collection_file_overrides: list[CollectionFileOverride] = Field(default_factory=list)


class ParseRequest(BaseModel):
    title: str = Field(min_length=1, max_length=1000)


class ShowDetailRead(ShowRead):
    subscription: FeedRead
    genres: list[str] = Field(default_factory=list)
    vote_count: int | None = None
    metadata_scraped_at: datetime | None = None


class ShowReleaseRead(BaseModel):
    id: int
    title: str
    published_at: datetime | None
    discovered_at: datetime
    parse_status: str
    parsed: ParsedRelease | None


class ShowReleasePage(BaseModel):
    items: list[ShowReleaseRead]
    total: int
    page: int
    page_size: int


class ShowEpisodeRead(BaseModel):
    path: str
    media_id: str | None = None
    progress: dict | None = None
    filename: str
    season: int | None
    episode_start: float | None
    episode_end: float | None
    size: int
    modified_at: datetime
    added_at: datetime | None = None
    thumbnail_url: str | None = None
    rename_pending: bool = False


class EpisodeRenameRequest(BaseModel):
    media_id: str = Field(pattern=r"^[a-f0-9]{64}$")
    filename: str = Field(min_length=1, max_length=255)


class EpisodeRenameRead(BaseModel):
    message: str
    path: str
    filename: str
    pending: bool


class ShowSeasonRead(BaseModel):
    season: int | None
    items: list[ShowEpisodeRead]


class ShowLibraryRead(BaseModel):
    available: bool
    partial: bool = False
    total: int
    seasons: list[ShowSeasonRead]


class FeedRefreshResult(BaseModel):
    source_id: int
    fetched: int
    created: int
    duplicates: int
    not_modified: bool = False


class LogRead(BaseModel):
    source_id: int | None = None
    operation_id: str | None = None
    id: int
    occurred_at: datetime
    level: Literal["info", "warning", "error"]
    scope: str
    event_type: str
    message: str


class DownloaderCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    kind: Literal["qbittorrent", "aria2"]
    base_url: str = Field(min_length=1, max_length=500)
    username: str | None = Field(default=None, max_length=160)
    secret: str | None = Field(default=None, max_length=500)
    verify_tls: bool = True
    active: bool = True
    remote_download_root: str | None = Field(default=None, max_length=1000)
    local_download_root: str | None = Field(default=None, max_length=1000)
    library_root: str | None = Field(default=None, max_length=1000)
    organize_strategy: Literal["downloader_managed", "hardlink", "copy"] = "downloader_managed"

    @field_validator("base_url")
    @classmethod
    def normalize_url(cls, value: str) -> str:
        value = value.strip().rstrip("/")
        if not value.startswith(("http://", "https://")):
            value = f"http://{value}"
        return value


class DownloaderUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    kind: Literal["qbittorrent", "aria2"]
    base_url: str = Field(min_length=1, max_length=500)
    username: str | None = Field(default=None, max_length=160)
    secret: str | None = Field(default=None, max_length=500)
    verify_tls: bool = True
    active: bool = True
    organize_strategy: Literal["downloader_managed", "hardlink", "copy"] = "downloader_managed"

    @field_validator("base_url")
    @classmethod
    def normalize_url(cls, value: str) -> str:
        value = value.strip().rstrip("/")
        if not value.startswith(("http://", "https://")):
            value = f"http://{value}"
        return value


class DownloaderRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    kind: str
    base_url: str
    username: str | None
    verify_tls: bool
    active: bool
    remote_download_root: str | None
    local_download_root: str | None
    library_root: str | None
    organize_strategy: str
    connection_status: str
    last_checked_at: datetime | None
    last_error: str | None
    created_at: datetime


class DownloaderTestResult(BaseModel):
    ok: bool
    kind: str
    version: str | None = None
    message: str


class DownloadTaskRead(BaseModel):
    review_required: bool = False
    source_id: int
    automation_state: str | None = None
    automation_error: str | None = None
    retry_attempts: int = 0
    next_retry_at: datetime | None = None
    id: int
    title: str
    source_name: str
    download_url: str
    info_hash: str | None
    published_at: datetime | None
    discovered_at: datetime
    matched: bool
    status: str
    qb_state: str | None = None
    progress: float = 0
    download_speed: int = 0
    upload_speed: int = 0
    eta: int | None = None
    size: int = 0
    downloaded: int = 0


class DownloadCenterRead(BaseModel):
    downloader_configured: bool
    downloader_online: bool
    downloader_name: str | None = None
    downloader_version: str | None = None
    download_speed: int = 0
    upload_speed: int = 0
    error: str | None = None
    tasks: list[DownloadTaskRead] = Field(default_factory=list)


class PathPreviewRequest(BaseModel):
    title: str = "番名"
    canonical_title: str = "番名"
    year: int | None = None
    season: int = Field(default=1, ge=0, le=99)
    episode: float = Field(default=5, ge=0)
    extension: str = ".mkv"
    library_root: str = "./data/library"


class PathPreviewResponse(BaseModel):
    parsed: ParsedRelease
    directory: str
    filename: str
    full_path: str
    library_root: str
    folder_name: str
    season_folder: str
    separator: str


class DashboardSummary(BaseModel):
    feeds: int
    healthy_feeds: int
    discovered_items: int
    needs_review: int
    downloaders: int
    healthy_downloaders: int
    recent_items: list[dict]
