"""受限参数生成与 MPEG-TS 首视频 PTS 探测。"""

import json
import math
from pathlib import Path

from ..config import settings
from .media import MediaError, ResolvedMedia
from .planner import PlaybackPlan
from .probe import run_media_command
from .schemas import PlaybackInfo

SEGMENT_SECONDS = 3
MAX_SEEK_PREROLL = 30.0
TIMESTAMP_OFFSET = 1.0  # 保留 AAC encoder priming 的负相对 PTS，避免 MPEG-TS 回绕。


def command(
    media: ResolvedMedia,
    info: PlaybackInfo,
    directory: Path,
    position: float,
    quality: int,
    audio_track: int | None,
    encoder: str | None = None,
    seek_preroll: float = 0,
    plan: PlaybackPlan | None = None,
) -> list[str]:
    if quality not in info.qualities:
        raise MediaError("invalid_quality", "选择的清晰度不可用", 422)
    if audio_track is not None and audio_track not in {track.id for track in info.audio_tracks}:
        raise MediaError("invalid_audio_track", "选择的音轨不可用", 422)
    if plan and plan.mode == "remux":
        return remux_command(
            media,
            info,
            directory,
            position,
            audio_track,
            copy_audio=plan.copy_audio,
            seek_preroll=seek_preroll,
        )
    codec = encoder or settings.playback_encoder
    if codec not in {"libx264", "h264_nvenc", "h264_qsv", "h264_amf", "h264_mf"}:
        raise MediaError("encoder_unavailable", "配置的播放编码器不受支持", 503)
    # 输出保持比例，偶数宽高；两个 min 同时限制源尺寸与请求尺寸。
    height = min(quality, info.video_height)
    width = min(round(height * info.video_width / info.video_height), info.video_width)
    width, height = max(2, width // 2 * 2), max(2, height // 2 * 2)
    coarse_seek = max(0, position - min(MAX_SEEK_PREROLL, max(0, seek_preroll)))
    if media.path.suffix.lower() in {".ts", ".m2ts", ".mts"}:
        # TS 索引可能向后落到下一关键帧；先从目标之前读取，再准确 trim。
        coarse_seek = max(0, position - MAX_SEEK_PREROLL)
    result = [
        settings.playback_ffmpeg,
        "-hide_banner",
        "-loglevel",
        "warning",
        "-nostats",
        "-y",
        "-progress",
        "pipe:1",
        "-stats_period",
        "0.5",
        "-threads",
        str(max(1, min(settings.playback_threads, 16))),
        "-copyts",
        "-start_at_zero",
        "-ss",
        f"{coarse_seek:.6f}",
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        "mov,matroska,webm,avi,mpegts,mpeg,flv,asf,ogg",
        "-readrate",
        "8",
        "-i",
        str(media.path),
        "-map",
        f"0:{info.video_track}",
    ]
    if info.audio_tracks:
        selected_audio = audio_track if audio_track is not None else info.audio_tracks[0].id
        result += ["-map", f"0:{selected_audio}"]
    else:
        result += ["-an"]
    result += [
        "-sn",
        "-dn",
        "-vf",
        f"trim=start={position:.6f},scale={width}:{height}",
        "-af",
        f"atrim=start={position:.6f}",
        "-c:v",
        codec,
        "-pix_fmt",
        "yuv420p",
        "-bf",
        "0",
        "-threads",
        str(max(1, min(settings.playback_threads, 16))),
    ]
    if codec == "libx264":
        result += ["-preset", "veryfast", "-crf", "23", "-sc_threshold", "0"]
    elif codec == "h264_nvenc":
        # NVENC 默认把强制关键帧编码为非 IDR；HLS 需要 IDR 才能按时切片。
        result += ["-preset", "p3", "-rc", "vbr", "-cq", "23", "-forced-idr", "1"]
    bitrate = "4500k" if quality >= 1080 else "2800k"
    maxrate, bufsize = "6000k", "12000k"
    if plan is not None and plan.video_bitrate is not None:
        bitrate = str(min(4_500_000 if quality >= 1080 else 2_800_000, plan.video_bitrate))
        maxrate, bufsize = str(plan.video_bitrate), str(plan.video_bitrate * 2)
    result += [
        "-b:v",
        bitrate,
        "-maxrate",
        maxrate,
        "-bufsize",
        bufsize,
        "-force_key_frames",
        "expr:if(isnan(prev_forced_t),1,gte(t,prev_forced_t+3))",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-ac",
        "2",
        "-ar",
        "48000",
        "-avoid_negative_ts",
        "disabled",
        "-f",
        "hls",
        "-hls_time",
        str(SEGMENT_SECONDS),
        "-hls_list_size",
        "60",
        "-hls_segment_type",
        "mpegts",
        "-hls_flags",
        "temp_file+independent_segments",
        "-hls_segment_options",
        f"mpegts_copyts=1:output_ts_offset={TIMESTAMP_OFFSET}",
        "-hls_segment_filename",
        str(directory / "segment-%07d.ts"),
        str(directory / "index.m3u8"),
    ]
    return result


def remux_command(
    media: ResolvedMedia,
    info: PlaybackInfo,
    directory: Path,
    position: float,
    audio_track: int | None,
    *,
    copy_audio: bool,
    seek_preroll: float = 0,
) -> list[str]:
    coarse_seek = max(0, position - min(MAX_SEEK_PREROLL, max(0, seek_preroll)))
    if media.path.suffix.lower() in {".ts", ".m2ts", ".mts"}:
        coarse_seek = max(0, position - MAX_SEEK_PREROLL)
    result = [
        settings.playback_ffmpeg,
        "-hide_banner",
        "-loglevel",
        "warning",
        "-nostats",
        "-y",
        "-progress",
        "pipe:1",
        "-stats_period",
        "0.5",
        "-copyts",
        "-start_at_zero",
        "-ss",
        f"{coarse_seek:.6f}",
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        "mov,matroska,webm,avi,mpegts,mpeg,flv,asf,ogg",
        "-readrate",
        "8",
        "-i",
        str(media.path),
        "-map",
        f"0:{info.video_track}",
        "-sn",
        "-dn",
        "-c:v",
        "copy",
    ]
    if info.audio_tracks:
        selected_audio = audio_track if audio_track is not None else info.audio_tracks[0].id
        result += ["-map", f"0:{selected_audio}"]
        if copy_audio:
            result += ["-c:a", "copy"]
        else:
            result += ["-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000"]
    else:
        result += ["-an"]
    result += [
        "-avoid_negative_ts",
        "disabled",
        "-f",
        "hls",
        "-hls_time",
        str(SEGMENT_SECONDS),
        "-hls_list_size",
        "60",
        "-hls_segment_type",
        "mpegts",
        "-hls_flags",
        "temp_file",
        "-hls_segment_options",
        f"mpegts_copyts=1:output_ts_offset={TIMESTAMP_OFFSET}",
        "-hls_segment_filename",
        str(directory / "segment-%07d.ts"),
        str(directory / "index.m3u8"),
    ]
    return result


async def video_start(path: Path) -> float:
    payload = await run_media_command(
        [
            settings.playback_ffprobe,
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=start_time",
            "-of",
            "json",
            str(path),
        ],
        settings.playback_probe_timeout_seconds,
    )
    try:
        value = float(json.loads(payload)["streams"][0]["start_time"])
        if not math.isfinite(value):
            raise ValueError
        return value
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise MediaError("timestamp_invalid", "无法读取转码分片的实际时间戳", 422) from exc
