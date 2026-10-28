import asyncio
import json
import re
import shutil
import sys
from dataclasses import replace

import psutil
import pytest
from test_playback_media import probe_json, resolved

from app.playback import leases, probe
from app.playback.media import MediaError, ResolvedMedia, file_version

ASS = (
    r"""[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
"""
    + "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, "
    "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, "
    "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
    "Style: Default,Arial,36,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,"
    "0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1\n"
    + r"""

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.23,0:00:03.45,Default,,0,0,0,,{\i1}简体中文{\i0}\N第二行
"""
)
SSA = (
    r"""[Script Info]
ScriptType: v4.00
PlayResX: 1280
PlayResY: 720

[V4 Styles]
"""
    + "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, TertiaryColour, "
    "BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, "
    "MarginR, MarginV, AlphaLevel, Encoding\n"
    + r"""
Style: Default,Arial,36,16777215,255,0,0,0,0,1,2,0,2,10,10,10,0,1

[Events]
Format: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: Marked=0,0:00:01.23,0:00:03.45,Default,,0,0,0,,{\i1}简体中文{\i0}\N第二行
"""
)


@pytest.fixture
def media(tmp_path):
    item = resolved(tmp_path)
    probe._cache.pop(item.media_id, None)
    probe._subtitle_cache.clear()
    probe._remember(item.media_id, probe.parse_probe(item, probe_json()))
    return item


def assert_chinese_cue(content):
    assert content.startswith("WEBVTT")
    assert re.search(r"(?:00:)?00:01\.230 --> (?:00:)?00:03\.450", content)
    text = re.sub(r"<[^>]+>", "", content)
    assert "简体中文\n第二行" in text
    assert "\\N" not in content and "{\\i1}" not in content


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="没有安装 FFmpeg")
@pytest.mark.parametrize("extension,content", [("ass", ASS), ("ssa", SSA)])
async def test_external_ass_and_ssa_preserve_chinese_lines_and_timestamps(
    media,
    extension,
    content,
):
    subtitle = media.path.with_name(f"{media.path.stem}.zh-Hans.{extension}")
    subtitle.write_text(content, encoding="utf-8-sig")
    original = subtitle.read_bytes()
    info = await probe.probe_media(media)
    track = next(item for item in info.subtitle_tracks if item.id.startswith("e:"))
    assert track.supported and track.url and track.codec == extension
    converted = await probe.subtitle_content(media, track.id)
    assert_chinese_cue(converted)
    assert await probe.subtitle_content(media, track.id) == converted
    assert subtitle.read_bytes() == original and media.path.read_bytes() == b"test-video"
    assert not leases.source_in_use(media.source_id)


async def test_external_ass_conversion_uses_only_validated_stdin_and_a_shared_lease(
    media,
    monkeypatch,
):
    subtitle = media.path.with_suffix(".ass")
    subtitle.write_text(ASS, encoding="utf-8-sig")
    calls = []

    async def command(arguments, timeout, max_bytes, *, input_bytes):
        calls.append(arguments)
        assert leases.source_in_use(media.source_id)
        assert arguments[arguments.index("-protocol_whitelist") + 1] == "pipe"
        assert arguments[arguments.index("-format_whitelist") + 1] == "ass"
        assert arguments[arguments.index("-i") + 1] == "pipe:0"
        assert str(subtitle) not in arguments and str(media.path) not in arguments
        assert input_bytes == subtitle.read_bytes().decode("utf-8-sig").encode("utf-8")
        assert max_bytes == 5 * 1024 * 1024 and timeout > 0
        return "WEBVTT\n\n00:01.230 --> 00:03.450\n简体中文\n第二行\n".encode()

    monkeypatch.setattr(probe, "run_media_command", command)
    info = await probe.probe_media(media)
    track = next(item for item in info.subtitle_tracks if item.id.startswith("e:"))
    first, second = await asyncio.gather(
        probe.subtitle_content(media, track.id),
        probe.subtitle_content(media, track.id),
    )
    assert first == second and len(calls) == 1
    assert await probe.subtitle_content(media, track.id) == first and len(calls) == 1
    assert not leases.source_in_use(media.source_id)


@pytest.mark.parametrize(
    "raw,code",
    [
        (b"\xff\xfeinvalid", "subtitle_encoding"),
        (b"x" * (5 * 1024 * 1024 + 1), "subtitle_too_large"),
    ],
    ids=["invalid-utf8", "too-large"],
)
async def test_external_ass_rejects_invalid_encoding_and_oversized_input(media, raw, code):
    media.path.with_suffix(".ass").write_bytes(raw)
    info = await probe.probe_media(media)
    track = next(item for item in info.subtitle_tracks if item.id.startswith("e:"))
    with pytest.raises(MediaError) as error:
        await probe.subtitle_content(media, track.id)
    assert error.value.code == code and error.value.status == 422
    assert not leases.source_in_use(media.source_id)


@pytest.mark.parametrize("source", ["persisted", "memory"])
async def test_version_two_ass_unsupported_cache_is_refreshed(media, monkeypatch, source):
    stale = probe.parse_probe(media, probe_json())
    stale.probe_schema_version = 2
    stale.subtitle_tracks[-1].supported = False
    stale.subtitle_tracks[-1].reason = "旧版不支持 ASS"
    if source == "persisted":
        probe._cache.pop(media.media_id, None)
        media = replace(media, probe_json=stale.model_dump_json())
    else:
        probe._remember(media.media_id, stale)
    calls = []

    async def command(*_args, **_kwargs):
        calls.append(1)
        return json.dumps(probe_json()).encode()

    monkeypatch.setattr(probe, "run_media_command", command)
    info = await probe.probe_media(media)
    assert calls == [1] and info.probe_schema_version == probe.PROBE_SCHEMA_VERSION
    track = info.subtitle_tracks[-1]
    assert track.codec == "ass" and track.supported and track.reason is None
    assert track.url == f"/api/v1/media/{media.media_id}/subtitles/{track.id}"


@pytest.mark.skipif(
    not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="没有安装 FFmpeg/FFprobe"
)
async def test_embedded_ass_is_probed_and_extracted_as_webvtt(tmp_path):
    path = tmp_path / "embedded-ass.mkv"
    await probe.run_media_command(
        [
            "ffmpeg",
            "-v",
            "error",
            "-nostdin",
            "-f",
            "lavfi",
            "-i",
            "color=size=128x72:rate=24",
            "-f",
            "ass",
            "-i",
            "pipe:0",
            "-t",
            "4",
            "-map",
            "0:v:0",
            "-map",
            "1:s:0",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:s",
            "ass",
            "-metadata:s:s:0",
            "language=chi",
            str(path),
        ],
        10,
        input_bytes=ASS.encode("utf-8"),
    )
    stat = path.stat()
    version = file_version(path.name, stat.st_size, stat.st_mtime_ns)
    media = ResolvedMedia(
        version, 9827, path, version, stat.st_size, stat.st_mtime_ns, tmp_path, tmp_path, path.name
    )
    original = path.read_bytes()
    info = await probe.probe_media(media)
    track = info.subtitle_tracks[0]
    assert track.codec == "ass" and track.language == "chi" and track.supported and track.url
    assert_chinese_cue(await probe.subtitle_content(media, track.id))
    assert path.read_bytes() == original and not leases.source_in_use(media.source_id)


async def test_media_command_large_stdin_does_not_deadlock_output_drain():
    content = "中文测试\n".encode() * 100_000
    output = await probe.run_media_command(
        [
            sys.executable,
            "-c",
            "import sys; sys.stdout.buffer.write(sys.stdin.buffer.read())",
        ],
        5,
        input_bytes=content,
    )
    assert output == content


async def test_media_command_timeout_interrupts_blocked_stdin_writer():
    with pytest.raises(MediaError) as error:
        await probe.run_media_command(
            [
                sys.executable,
                "-c",
                "import time; time.sleep(10)",
            ],
            0.1,
            input_bytes=b"x" * (5 * 1024 * 1024),
        )
    assert error.value.code == "probe_timeout"


async def test_cancelled_stdin_command_collects_child_process(tmp_path):
    marker = tmp_path / "stdin-child.pid"
    code = (
        "from pathlib import Path; import os,time; "
        f"Path({str(marker)!r}).write_text(str(os.getpid())); time.sleep(10)"
    )
    task = asyncio.create_task(
        probe.run_media_command(
            [sys.executable, "-c", code],
            20,
            input_bytes=b"x" * (5 * 1024 * 1024),
        )
    )
    async with asyncio.timeout(5):
        while not marker.exists():
            await asyncio.sleep(0.01)
    pid = int(marker.read_text())
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    try:
        await asyncio.to_thread(psutil.Process(pid).wait, timeout=2)
    except psutil.NoSuchProcess:
        pass
