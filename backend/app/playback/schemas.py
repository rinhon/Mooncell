"""播放接口的稳定数据契约，所有时间均以源文件秒数表示。"""

from datetime import datetime

from pydantic import BaseModel, Field


class AudioTrack(BaseModel):
    id: int
    codec: str
    language: str | None = None
    title: str | None = None
    channels: int | None = None
    default: bool = False


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
    frame_rate: float = 24
    hdr: bool = False
    supported: bool = True
    unsupported_reason: str | None = None
    qualities: list[int] = Field(default_factory=lambda: [720, 1080])
    audio_tracks: list[AudioTrack] = Field(default_factory=list)
    subtitle_tracks: list[SubtitleTrack] = Field(default_factory=list)
    progress: ProgressRead | None = None


class PlaybackCapabilities(BaseModel):
    available: bool
    ffmpeg: bool
    ffprobe: bool
    encoder: str
    hardware_encoders: list[str] = Field(default_factory=list)
    reason: str | None = None
