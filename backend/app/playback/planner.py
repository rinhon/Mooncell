"""保守的播放模式选择；未知能力和元数据始终回到已验证转码路径。"""

from dataclasses import dataclass, replace
from typing import Literal

from .media import MediaError
from .schemas import ClientPlaybackCapabilities, PlaybackInfo

PlaybackMode = Literal["direct", "remux", "transcode"]
MIN_TOTAL_BITRATE = 256_000
MAX_TOTAL_BITRATE = 200_000_000
AUDIO_BITRATE = 128_000


@dataclass(frozen=True)
class PlaybackPlan:
    mode: PlaybackMode
    reason: str
    mime_type: str
    quality: int
    output_quality: int
    copy_audio: bool = False
    video_bitrate: int | None = None  # 转码视频 VBV 上限，单位 bit/s。
    total_bitrate: int | None = None


def avc_codec(profile: str | None, level: int | None) -> str | None:
    profile_id = {
        "Constrained Baseline": "42E0",
        "Baseline": "4200",
        "Main": "4D00",
        "High": "6400",
    }.get(profile or "")
    if profile_id is None or level is None or not 9 <= level <= 52:
        return None
    return f"avc1.{profile_id}{level:02X}"


def set_playback_mime_types(info: PlaybackInfo) -> None:
    """只公布第一轮已支持的 H.264 8-bit SDR；AAC 必须是 LC。"""
    codec = avc_codec(info.video_profile, info.video_level)
    if info.video_codec != "h264" or info.hdr or info.pixel_format != "yuv420p" or not codec:
        return
    # 重封装时可将不兼容音轨转成 AAC，因此 HLS 类型独立于原文件音频。
    audio_suffix = ", mp4a.40.2" if info.audio_tracks else ""
    info.hls_mime_type = f'video/mp4; codecs="{codec}{audio_suffix}"'
    if (
        "mp4" in info.container.split(",")
        and info.container_brand in {"isom", "iso2", "avc1", "mp41", "mp42", "M4V "}
        and abs(info.source_start) < 0.01
        and abs(info.video_start) < 0.1
        and all(
            track.codec == "aac" and track.profile == "LC" and (track.channels or 0) <= 2
            for track in info.audio_tracks
        )
    ):
        info.native_mime_type = info.hls_mime_type


def plan_playback(
    info: PlaybackInfo,
    quality: int,
    audio_track: int | None,
    capabilities: ClientPlaybackCapabilities | None = None,
    *,
    force_transcode: bool = False,
    max_bitrate: int | None = None,
) -> PlaybackPlan:
    if quality != 0 and quality not in info.qualities:
        raise MediaError("invalid_quality", "选择的清晰度不可用", 422)
    if audio_track is not None and audio_track not in {track.id for track in info.audio_tracks}:
        raise MediaError("invalid_audio_track", "选择的音轨不可用", 422)
    if max_bitrate is not None and not MIN_TOTAL_BITRATE <= max_bitrate <= MAX_TOTAL_BITRATE:
        raise MediaError("invalid_bitrate", "码率上限必须介于 256000 和 200000000 bit/s", 422)
    output_quality = info.qualities[-1] if quality == 0 else quality
    # 为 AAC 及 TS 封装保留预算；即使无音轨也沿用保守预算，不能用总上限直接作视频上限。
    video_bitrate = (
        min(6_000_000, max_bitrate * 9 // 10 - AUDIO_BITRATE) if max_bitrate is not None else None
    )
    baseline = PlaybackPlan(
        "transcode",
        "按客户端能力转码",
        "application/vnd.apple.mpegurl",
        quality,
        output_quality,
        video_bitrate=video_bitrate,
        total_bitrate=max_bitrate,
    )
    if capabilities is None or force_transcode:
        return baseline
    if quality != 0 and quality < info.video_height:
        return replace(baseline, reason="按所选清晰度缩放")
    if max_bitrate is not None and (info.bit_rate is None or info.bit_rate > max_bitrate):
        return replace(baseline, reason="按客户端码率上限转码")
    selected = next((track for track in info.audio_tracks if track.id == audio_track), None)
    if selected is None and info.audio_tracks:
        selected = info.audio_tracks[0]
    # HTML video 的文件内音轨切换没有统一保证。仅默认/首轨直放，其余走显式 map。
    browser_audio = next(
        (track for track in info.audio_tracks if track.default),
        info.audio_tracks[0] if info.audio_tracks else None,
    )
    selectable = selected is None or (selected == browser_audio and len(info.audio_tracks) <= 1)
    if (
        info.native_mime_type
        and info.native_mime_type in capabilities.native_mime_types
        and selectable
    ):
        return PlaybackPlan(
            "direct",
            "客户端支持原文件格式",
            "video/mp4",
            quality,
            output_quality,
            copy_audio=True,
            total_bitrate=max_bitrate,
        )
    if info.hls_mime_type and info.hls_mime_type in capabilities.hls_mime_types:
        copy_audio = selected is None or (
            selected.codec == "aac" and selected.profile == "LC" and (selected.channels or 0) <= 2
        )
        return PlaybackPlan(
            "remux",
            "复制视频并适配容器或音轨",
            baseline.mime_type,
            quality,
            output_quality,
            copy_audio,
            total_bitrate=max_bitrate,
        )
    return baseline
