"""播放接口的稳定数据契约，所有时间均以源文件秒数表示。"""

from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, Field, StringConstraints


class AudioTrack(BaseModel):
    id: int
    codec: str
    language: str | None = None
    title: str | None = None
    channels: int | None = None
    default: bool = False
    profile: str | None = None
    sample_rate: int | None = None


class SubtitleTrack(BaseModel):
    id: str
    codec: str
    language: str | None = None
    title: str | None = None
    supported: bool
    reason: str | None = None
    url: str | None = None


class ProgressRead(BaseModel):
    position: float = 0
    duration: float = 0
    completed: bool = False
    updated_at: datetime | None = None


class ProgressUpdate(BaseModel):
    session_id: str = Field(min_length=1, max_length=64)
    generation: int = Field(ge=1)
    seek_revision: int | None = Field(default=None, ge=0)
    sequence: int = Field(ge=0)
    position: float = Field(ge=0, allow_inf_nan=False)
    completed: bool = False


class PlaybackInfo(BaseModel):
    media_id: str
    source_id: int
    filename: str
    version: str
    duration: float
    video_width: int
    video_height: int
    video_codec: str
    video_track: int = 0
    probe_schema_version: int = 1
    container: str = ""
    container_brand: str | None = None
    video_profile: str | None = None
    video_level: int | None = None
    pixel_format: str | None = None
    bit_rate: int | None = None
    source_start: float = 0
    video_start: float = 0
    native_mime_type: str | None = None
    hls_mime_type: str | None = None
    frame_rate: float = 24
    hdr: bool = False
    supported: bool = True
    unsupported_reason: str | None = None
    qualities: list[int] = Field(default_factory=lambda: [720, 1080])
    audio_tracks: list[AudioTrack] = Field(default_factory=list)
    subtitle_tracks: list[SubtitleTrack] = Field(default_factory=list)
    progress: ProgressRead | None = None


class ClientPlaybackCapabilities(BaseModel):
    """客户端实际检测成功的完整 MIME；缺省继续走已有转码路径。"""

    native_mime_types: list[Annotated[str, StringConstraints(max_length=160)]] = Field(
        default_factory=list,
        max_length=16,
    )
    hls_mime_types: list[Annotated[str, StringConstraints(max_length=160)]] = Field(
        default_factory=list,
        max_length=16,
    )


class PlaybackCapabilities(BaseModel):
    available: bool
    ffmpeg: bool
    ffprobe: bool
    encoder: str
    hardware_encoders: list[str] = Field(default_factory=list)
    reason: str | None = None
