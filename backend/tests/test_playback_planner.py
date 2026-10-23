import asyncio
import json
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from pydantic import ValidationError

from app.playback import leases, probe
from app.playback.direct import DirectFileResponse
from app.playback.media import MediaError, ResolvedMedia, file_version
from app.playback.planner import plan_playback
from app.playback.schemas import ClientPlaybackCapabilities
from app.playback.session_router import CreateSession, SessionOptions


def media_file(tmp_path: Path) -> ResolvedMedia:
    path = tmp_path / "sample.mp4"
    path.write_bytes(bytes(range(256)) * 4)
    stat = path.stat()
    version = file_version(path.name, stat.st_size, stat.st_mtime_ns)
    return ResolvedMedia(version, 9721, path, version, stat.st_size, stat.st_mtime_ns,
                         tmp_path, tmp_path, path.name)


def metadata():
    return {"format": {"duration": "120", "format_name": "mov,mp4,m4a,3gp,3g2,mj2",
                       "start_time": "0", "bit_rate": "2000000",
                       "tags": {"major_brand": "isom"}}, "streams": [
        {"index": 0, "codec_type": "video", "codec_name": "h264", "profile": "High",
         "level": 40, "pix_fmt": "yuv420p", "width": 1920, "height": 1080,
         "avg_frame_rate": "24000/1001", "start_time": "0"},
        {"index": 1, "codec_type": "audio", "codec_name": "aac", "profile": "LC",
         "channels": 2, "sample_rate": "48000", "disposition": {"default": 1}},
    ]}


def capable(info):
    return ClientPlaybackCapabilities(native_mime_types=[info.native_mime_type],
                                      hls_mime_types=[info.hls_mime_type])


def test_planner_requires_detected_capability_and_respects_constraints(tmp_path):
    info = probe.parse_probe(media_file(tmp_path), metadata())
    assert info.probe_schema_version == probe.PROBE_SCHEMA_VERSION
    assert info.native_mime_type == 'video/mp4; codecs="avc1.640028, mp4a.40.2"'
    assert plan_playback(info, 1080, 1).mode == "transcode"
    assert plan_playback(info, 0, 1, capable(info)).mode == "direct"
    assert plan_playback(info, 720, 1, capable(info)).mode == "transcode"
    assert plan_playback(info, 0, 1, capable(info), max_bitrate=1_000_000).mode == "transcode"
    assert plan_playback(info, 0, 1, capable(info), force_transcode=True).mode == "transcode"
    with pytest.raises(MediaError, match="音轨"):
        plan_playback(info, 0, 99, capable(info))


@pytest.mark.parametrize("bitrate", [256_000, 1_000_000, 20_000_000])
@pytest.mark.parametrize("reason", ["legacy", "forced", "resolution", "source-rate"])
def test_transcode_plan_reserves_audio_and_transport_bitrate_in_every_fallback(
    tmp_path, bitrate, reason,
):
    info = probe.parse_probe(media_file(tmp_path), metadata())
    info.bit_rate = 40_000_000
    plan = plan_playback(
        info, 720 if reason == "resolution" else 0, 1,
        None if reason == "legacy" else capable(info),
        force_transcode=reason == "forced", max_bitrate=bitrate,
    )
    assert plan.mode == "transcode" and plan.total_bitrate == bitrate
    assert 0 < plan.video_bitrate <= 6_000_000
    assert plan.video_bitrate + 128_000 <= bitrate * 9 // 10
    assert plan_playback(info, 0, 1).video_bitrate is None


@pytest.mark.parametrize("bitrate", [64_000, 255_999, 200_000_001])
def test_impossible_bitrate_is_rejected_by_api_and_planner(tmp_path, bitrate):
    info = probe.parse_probe(media_file(tmp_path), metadata())
    with pytest.raises(MediaError) as invalid:
        plan_playback(info, 0, 1, capable(info), max_bitrate=bitrate)
    assert invalid.value.code == "invalid_bitrate" and invalid.value.status == 422
    with pytest.raises(ValidationError):
        CreateSession(media_id="id", request_id="00000000-0000-4000-8000-000000000001",
                      max_bitrate=bitrate)
    with pytest.raises(ValidationError):
        SessionOptions(generation=1, position=0,
                       request_id="00000000-0000-4000-8000-000000000001", max_bitrate=bitrate)


def test_planner_maps_other_audio_explicitly_and_only_copies_compatible_audio(tmp_path):
    media = media_file(tmp_path)
    data = metadata()
    data["streams"].append({"index": 2, "codec_type": "audio", "codec_name": "ac3",
                            "channels": 6})
    info = probe.parse_probe(media, data)
    capabilities = ClientPlaybackCapabilities(hls_mime_types=[info.hls_mime_type])
    plan = plan_playback(info, 0, 2, capabilities)
    assert plan.mode == "remux" and not plan.copy_audio
    assert plan_playback(info, 0, 1, capabilities).copy_audio
    data["streams"][2].update(codec_name="aac", profile="LC", channels=2)
    info = probe.parse_probe(media, data)
    assert info.native_mime_type
    assert plan_playback(info, 0, 2, capable(info)).mode == "remux"


@pytest.mark.parametrize("change", ["high10", "unknown-profile", "hdr", "nonzero", "quicktime"])
def test_planner_does_not_guess_native_support(tmp_path, change):
    data = metadata()
    if change == "high10":
        data["streams"][0]["pix_fmt"] = "yuv420p10le"
    elif change == "unknown-profile":
        data["streams"][0]["profile"] = "unknown"
    elif change == "hdr":
        data["streams"][0]["color_transfer"] = "smpte2084"
    elif change == "nonzero":
        data["format"]["start_time"] = "5"
    else:
        data["format"]["tags"]["major_brand"] = "qt  "
    info = probe.parse_probe(media_file(tmp_path), data)
    assert info.native_mime_type is None


async def test_old_persisted_probe_schema_is_refreshed(tmp_path, monkeypatch):
    media = media_file(tmp_path)
    old = probe.parse_probe(media, metadata()).model_dump()
    old.pop("probe_schema_version")
    old.pop("native_mime_type")
    media = ResolvedMedia(**{**media.__dict__, "probe_json": json.dumps(old)})
    probe._cache.pop(media.media_id, None)
    calls = []

    async def command(*_args, **_kwargs):
        calls.append(1)
        return json.dumps(metadata()).encode()

    monkeypatch.setattr(probe, "run_media_command", command)
    info = await probe.probe_media(media)
    assert calls == [1] and info.native_mime_type


async def test_direct_response_ranges_head_if_range_and_leases(tmp_path):
    media = media_file(tmp_path)
    app = FastAPI()

    @app.api_route("/video", methods=["GET", "HEAD"])
    async def video():
        leases.acquire_source(media.source_id)
        return DirectFileResponse(media)

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                 base_url="http://test") as client:
        first = await client.get("/video", headers={"Range": "bytes=100-119"})
        assert first.status_code == 206
        assert first.content == media.path.read_bytes()[100:120]
        assert first.headers["content-range"] == "bytes 100-119/1024"
        assert first.headers["etag"] == f'"{media.version}"'
        assert not leases.source_in_use(media.source_id)
        tail = await client.get("/video", headers={"Range": "bytes=-5"})
        assert tail.status_code == 206 and tail.content == media.path.read_bytes()[-5:]
        invalid = await client.get("/video", headers={"Range": "bytes=1024-"})
        assert invalid.status_code == 416
        assert invalid.headers["content-range"] == "bytes */1024"
        head = await client.head("/video")
        assert head.status_code == 200 and not head.content
        assert head.headers["content-length"] == "1024"
        changed = await client.get("/video", headers={"Range": "bytes=0-2",
                                                      "If-Range": '"old-version"'})
        assert changed.status_code == 200 and len(changed.content) == 1024
        assert not leases.source_in_use(media.source_id)


async def test_direct_response_releases_lease_when_send_fails(tmp_path):
    media = media_file(tmp_path)
    leases.acquire_source(media.source_id)

    async def receive():
        return {"type": "http.disconnect"}

    async def send(_message):
        raise RuntimeError("client disconnected")

    with pytest.raises(RuntimeError, match="disconnected"):
        await DirectFileResponse(media)({"type": "http", "method": "GET", "headers": []},
                                         receive, send)
    assert not leases.source_in_use(media.source_id)


def test_existing_session_can_retain_response_while_migration_waits():
    source_id = 9722
    leases.acquire_source(source_id)
    try:
        assert not leases.begin_mutation(source_id)
        leases.retain_source(source_id)
        leases.release_source(source_id)
        assert leases.source_in_use(source_id)
    finally:
        leases.release_source(source_id)
        leases.finish_mutation(source_id)
    assert not leases.source_in_use(source_id)


async def test_external_subtitle_cache_invalidates_its_own_file_version(tmp_path, monkeypatch):
    from app.playback.schemas import SubtitleTrack

    media = media_file(tmp_path)
    subtitle = tmp_path / "sample.zh.vtt"
    subtitle.write_text("WEBVTT\n\nold", encoding="utf-8")
    track = SubtitleTrack(id="e:test", codec="vtt", supported=True)
    calls = []

    async def content(_media, _track_id):
        calls.append(1)
        return subtitle.read_text(encoding="utf-8")

    monkeypatch.setattr(probe, "_external_subtitles", lambda _media: [(track, subtitle)])
    monkeypatch.setattr(probe, "_subtitle_content", content)
    first = await probe.subtitle_content(media, track.id)
    assert await probe.subtitle_content(media, track.id) == first
    assert len(calls) == 1
    subtitle.write_text("WEBVTT\n\nreplacement text", encoding="utf-8")
    assert await probe.subtitle_content(media, track.id) != first
    assert len(calls) == 2


async def test_prewarm_queue_is_bounded_and_shutdown_clears_it(monkeypatch):
    from app.playback import metadata as background

    warmer = background.ProbePrewarmer()
    warmer.schedule(["not-started"])
    assert warmer.queue.empty()
    # 不让 worker 消费；验证扫描入队不依赖工具完成且不会无限累积。
    async def waiting():
        await asyncio.Event().wait()

    monkeypatch.setattr(warmer, "_run", waiting)
    warmer.start()
    warmer.schedule([str(index) for index in range(100)])
    assert warmer.queue.qsize() == 32
    assert len(warmer.pending) == 32
    await warmer.shutdown()
    assert warmer.queue.empty() and not warmer.pending


async def test_shared_probe_holds_read_lease_until_tool_finishes(tmp_path, monkeypatch):
    media = media_file(tmp_path)
    probe._cache.pop(media.media_id, None)
    entered, finish = asyncio.Event(), asyncio.Event()

    async def command(*_args, **_kwargs):
        entered.set()
        await finish.wait()
        return json.dumps(metadata()).encode()

    monkeypatch.setattr(probe, "run_media_command", command)
    caller = asyncio.create_task(probe.probe_media(media))
    await asyncio.wait_for(entered.wait(), 2)
    try:
        assert leases.source_in_use(media.source_id)
        assert not leases.begin_mutation(media.source_id)
        caller.cancel()
        with pytest.raises(asyncio.CancelledError):
            await caller
        assert leases.source_in_use(media.source_id)
        task = probe._inflight[media.media_id]
        finish.set()
        await task
        assert not leases.source_in_use(media.source_id)
    finally:
        finish.set()
        leases.finish_mutation(media.source_id)


async def test_subtitle_shared_task_keeps_lease_after_waiter_cancels(tmp_path, monkeypatch):
    media = media_file(tmp_path)
    entered, finish = asyncio.Event(), asyncio.Event()

    async def read(*_args):
        entered.set()
        await finish.wait()
        return "WEBVTT\n\nlease test"

    monkeypatch.setattr(probe, "_read_subtitle", read)
    caller = asyncio.create_task(probe.subtitle_content(media, "s:lease-test"))
    await asyncio.wait_for(entered.wait(), 2)
    try:
        assert not leases.begin_mutation(media.source_id)
        caller.cancel()
        with pytest.raises(asyncio.CancelledError):
            await caller
        assert leases.source_in_use(media.source_id)
        task = next(task for key, task in probe._subtitle_inflight.items()
                    if key[0] == media.media_id and key[1] == "s:lease-test")
        finish.set()
        await task
        assert not leases.source_in_use(media.source_id)
    finally:
        finish.set()
        leases.finish_mutation(media.source_id)
