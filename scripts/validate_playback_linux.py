"""在专有 Linux 容器和合成样本上验证播放后端；不访问真实媒体库。

docker run --init --name mooncell-playback-linux-validation --no-healthcheck --network none \
  -v <task-cache>:/validation -v <this-file>:/validation-script.py:ro \
  mooncell-playback-test python /validation-script.py --work /validation
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import subprocess
import sys
import time
import traceback
import uuid
from pathlib import Path


def process_command() -> list[str]:
    return [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i",
        "testsrc2=size=160x90:rate=24", "-an", "-c:v", "libx264", "-preset", "ultrafast",
        "-threads", "1", "-progress", "pipe:1", "-stats_period", "0.1", "-nostats",
        "-f", "null", "-",
    ]


def orphan_parent(marker: Path) -> None:
    from app.playback.processes import OwnedProcess

    process = OwnedProcess()
    process.start(process_command())
    deadline = time.monotonic() + 8
    while process.out_time < 0.25:
        if process.returncode is not None or time.monotonic() > deadline:
            raise RuntimeError("父进程测试中的 FFmpeg 未启动")
        time.sleep(0.05)
    marker.write_text(str(process.process.pid), encoding="utf-8")
    os._exit(23)  # 特意跳过 finally/析构，验证 Linux 内核负责终止 FFmpeg。


async def wait_until(predicate, timeout=15):
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(0.05)


async def verify_owned_process(work: Path) -> dict:
    import psutil

    from app.playback.processes import OwnedProcess

    process = OwnedProcess()
    process.start(process_command())
    pid = process.process.pid
    try:
        await wait_until(lambda: process.out_time >= 0.5)
        process.suspend()
        await asyncio.sleep(0.15)
        stopped_at = process.out_time
        assert psutil.Process(pid).status() == psutil.STATUS_STOPPED
        await asyncio.sleep(0.6)
        assert process.out_time - stopped_at < 0.15
        process.resume()
        await wait_until(lambda: process.out_time > stopped_at + 0.25)
        resumed_at = process.out_time
        process.suspend()
        assert process.suspended
    finally:
        await process.stop()
    assert process.returncode == 0 and not psutil.pid_exists(pid)
    return {"pid": pid, "suspended_out_time": stopped_at, "resumed_out_time": resumed_at,
            "normal_exit_code": process.returncode, "closed_while_suspended": True}


async def verify_parent_death(work: Path) -> dict:
    import psutil

    marker = work / "orphan-ffmpeg.pid"
    parent = await asyncio.to_thread(
        subprocess.Popen,
        [sys.executable, str(Path(__file__).resolve()), "--orphan-parent", str(marker)],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        code = await asyncio.to_thread(parent.wait, timeout=12)
        assert code == 23, f"父进程退出码异常：{code}"
        pid = int(marker.read_text(encoding="utf-8"))
        await wait_until(lambda: not psutil.pid_exists(pid), timeout=5)
        return {"parent_exit_code": code, "ffmpeg_pid": pid, "ffmpeg_reaped": True,
                "mechanism": "PR_SET_PDEATHSIG / SIGKILL"}
    finally:
        if parent.poll() is None:
            parent.kill()
            await asyncio.to_thread(parent.wait)


async def generate_samples(work: Path) -> dict:
    from app.playback.probe import run_media_command

    folder = work / "library" / "Synthetic" / "Season 01"
    folder.mkdir(parents=True, exist_ok=True)
    audio = folder / "Synthetic S01E01.mp4"
    silent = folder / "Synthetic S01E02.mkv"
    window = folder / "Synthetic S01E03.mp4"
    await run_media_command([
        "ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i",
        "testsrc2=size=320x180:rate=24", "-f", "lavfi", "-i",
        "sine=frequency=440:sample_rate=48000",
        "-t", "24", "-c:v", "libx264", "-preset", "ultrafast", "-threads", "2",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(audio),
    ], 45)
    await run_media_command([
        "ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i",
        "testsrc2=size=320x180:rate=24", "-t", "180", "-an", "-c:v", "libx264",
        "-preset", "ultrafast", "-threads", "2", "-pix_fmt", "yuv420p", str(window),
    ], 45)
    await run_media_command([
        "ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i",
        "testsrc2=size=320x180:rate=24", "-t", "18", "-an", "-c:v", "libx265",
        "-preset", "ultrafast", "-threads", "1", "-x265-params",
        "pools=1:frame-threads=1:log-level=error", "-pix_fmt", "yuv420p", str(silent),
    ], 45)
    audio.with_suffix(".zh.srt").write_text(
        "1\n00:00:01,000 --> 00:00:03,000\nLinux synthetic subtitle\n", encoding="utf-8",
    )
    return {"mp4": str(audio), "mkv": str(silent), "window_seek": str(window),
            "files_are_synthetic": True}


async def verify_cookie_hls_api(work: Path) -> dict:
    import httpx
    import uvicorn
    from fastapi import FastAPI

    from app.api import router as api_router
    from app.database import SessionFactory, init_database
    from app.models import FeedSource, LibrarySettings, ShowArtwork
    from app.playback.probe import run_media_command, shutdown_probes
    from app.playback.router import router as media_router
    from app.playback.session_router import router as session_router
    from app.playback.sessions import manager

    await init_database()
    async with SessionFactory() as session:
        source = FeedSource(id=101, name="Synthetic", url="https://synthetic.invalid/rss",
                            active=False, season=1)
        source.artwork = ShowArtwork(directory=str(work / "library" / "Synthetic"))
        session.add_all([source, LibrarySettings(id=1, library_root=str(work / "library"))])
        await session.commit()
    # 真实 HTTP + 生产路由/认证/SQL/会话，不启动与播放无关的联网后台轮询。
    app = FastAPI()
    app.include_router(api_router)
    app.include_router(media_router)
    app.include_router(session_router, prefix="/api/v1")
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=18766,
                                          log_level="warning", lifespan="off"))
    await manager.start()
    server_task = asyncio.create_task(server.serve())
    await wait_until(lambda: server.started or server_task.done())
    assert server.started
    credentials = {"username": "linux-validation", "password": "Synthetic-Playback-2026"}
    evidence = {}
    active = []

    async def expect(client, method, path, status=200, **kwargs):
        response = await client.request(method, "/api/v1" + path, **kwargs)
        assert response.status_code == status, (
            f"{method} {path}: {response.status_code} {response.text[:500]}"
        )
        return response

    async def ready(client, session_id):
        async with asyncio.timeout(30):
            while True:
                result = (await expect(client, "GET", f"/playback/sessions/{session_id}")).json()
                if result["status"] == "failed":
                    raise AssertionError(f"播放失败：{result}")
                if result["status"] in {"ready", "paused"}:
                    return result
                await asyncio.sleep(0.1)

    async def read_segment(client, state, target):
        playlist_url = state["playlist_url"]
        playlist = await client.get(playlist_url)
        assert playlist.status_code == 200 and playlist.headers["cache-control"] == "no-store"
        relative = next(
            line for line in playlist.text.splitlines() if line and not line.startswith("#")
        )
        segment_url = playlist_url.rsplit("/", 1)[0] + "/" + relative
        segment = await client.get(segment_url)
        assert segment.status_code == 200 and segment.content[0] == 0x47
        assert len(segment.content) % 188 == 0
        target.write_bytes(segment.content)
        await run_media_command([
            "ffmpeg", "-v", "error", "-nostdin", "-i", str(target), "-f", "null", "-",
        ], 20)
        return playlist_url, segment_url, len(segment.content)

    async def complete_playlist(client, state):
        try:
            async with asyncio.timeout(25):
                while True:
                    playlist = await client.get(state["playlist_url"])
                    assert playlist.status_code == 200, (
                        f"ENDLIST HTTP {playlist.status_code}: {playlist.text[:1000]}"
                    )
                    if "#EXT-X-ENDLIST" in playlist.text:
                        lengths = [float(line.partition(":")[2].partition(",")[0])
                                   for line in playlist.text.splitlines()
                                   if line.startswith("#EXTINF:")]
                        expected = state["duration"] - state["segments"][0]["source_start"]
                        assert lengths and abs(sum(lengths) - expected) < 0.25, (
                            f"ENDLIST 提前或末片缺失：{sum(lengths)} vs {expected}"
                        )
                        return len(lengths)
                    await asyncio.sleep(0.1)
        except TimeoutError as error:
            current = manager.get(1, state["id"])
            process = current.process
            detail = {"snapshot": manager.snapshot(current),
                      "pending_probes": list(current.pending_probes),
                      "process_returncode": process.returncode if process else None,
                      "suspended": process.suspended if process else None,
                      "out_time": process.out_time if process else None,
                      "stderr": list(process.stderr) if process else []}
            raise RuntimeError("ENDLIST timeout: " + json.dumps(detail)) from error

    try:
        async with httpx.AsyncClient(base_url="http://127.0.0.1:18766", timeout=40) as client:
            await expect(client, "GET", "/media/unknown/playback-info", 401)
            initialized = await expect(client, "POST", "/auth/bootstrap", 201, json=credentials)
            assert "HttpOnly" in initialized.headers["set-cookie"]
            assert client.cookies.get("mooncell_session")
            await expect(client, "POST", "/auth/logout")
            await expect(client, "GET", "/shows/101/library", 401)
            await expect(client, "POST", "/auth/login", json=credentials)
            library = (await expect(client, "GET", "/shows/101/library")).json()
            episodes = library["seasons"][0]["items"]
            assert len(episodes) == 3 and all(item["media_id"] for item in episodes)
            for episode in episodes:
                media_id = episode["media_id"]
                info = (await expect(client, "GET", f"/media/{media_id}/playback-info")).json()
                is_silent = episode["episode_start"] != 1
                window_seek = info["duration"] > 60
                assert info["supported"] and not info["hdr"]
                assert bool(info["audio_tracks"]) is (not is_silent)
                if episode["filename"].endswith(".mkv"):
                    assert info["video_codec"] == "hevc"
                if not is_silent:
                    track = next(track for track in info["subtitle_tracks"] if track["supported"])
                    subtitle = await client.get(track["url"])
                    assert subtitle.status_code == 200 and subtitle.text.startswith("WEBVTT")
                request_id = str(uuid.uuid4())
                body = {"media_id": media_id, "start_time": 0, "quality": 720,
                        "request_id": request_id}
                created = (
                    await expect(client, "POST", "/playback/sessions", 202, json=body)
                ).json()
                session_id = created["id"]
                active.append(session_id)
                duplicate = (
                    await expect(client, "POST", "/playback/sessions", 202, json=body)
                ).json()
                assert duplicate["id"] == session_id
                initial = await ready(client, session_id)
                old_playlist, old_segment, size = await read_segment(
                    client, initial, work / ("silent-first.ts" if is_silent else "audio-first.ts"),
                )
                first_source = initial["segments"][0]["source_start"]
                assert abs(first_source) < 0.1
                initial_fragments = (
                    None if window_seek else await complete_playlist(client, initial)
                )
                target = 160.3 if window_seek else 7.3
                seeking = (await expect(client, "POST",
                                       f"/playback/sessions/{session_id}/seek", 202,
                                       json={"generation": 1, "position": target,
                                             "request_id": str(uuid.uuid4())})).json()
                expected_generation = 2 if window_seek else 1
                assert seeking["generation"] == expected_generation
                next_state = await ready(client, session_id)
                seek_source = next_state["segments"][0]["source_start"]
                if window_seek:
                    assert abs(seek_source - target) < 0.1
                else:
                    assert manager.get(1, session_id).position == target
                await read_segment(client, next_state, work / ("silent-seek.ts" if is_silent
                                                             else "audio-seek.ts"))
                seek_fragments = await complete_playlist(client, next_state)
                old_status = 409 if window_seek else 200
                assert (await client.get(old_playlist)).status_code == old_status
                assert (await client.get(old_segment)).status_code == old_status
                await expect(client, "PUT", f"/media/{media_id}/progress", json={
                    "session_id": session_id, "generation": expected_generation,
                    "sequence": 1, "position": target + 1,
                })
                await expect(client, "PUT", f"/media/{media_id}/progress", 409, json={
                    "session_id": session_id, "generation": 1 if window_seek else 2,
                    "sequence": 99, "position": 1,
                })
                saved = (await expect(client, "GET", f"/media/{media_id}/progress")).json()
                assert saved["position"] == target + 1
                await expect(client, "POST", f"/playback/sessions/{session_id}/heartbeat", json={
                    "generation": expected_generation, "position": target,
                    "paused": True, "playback_rate": 1,
                })
                await expect(client, "POST", f"/playback/sessions/{session_id}/heartbeat", json={
                    "generation": expected_generation, "position": target,
                    "paused": False, "playback_rate": 1,
                })
                await expect(client, "POST", "/auth/logout")
                assert (await client.get(next_state["playlist_url"])).status_code == 401
                await expect(client, "POST", "/auth/login", json=credentials)
                await expect(client, "DELETE", f"/playback/sessions/{session_id}", 204)
                active.remove(session_id)
                key = ("window_seek_silent_mp4" if window_seek else
                       "silent_mkv_hevc" if is_silent else "mp4_h264_aac")
                evidence[key] = {
                    "duration": info["duration"], "video_codec": info["video_codec"],
                    "audio_tracks": len(info["audio_tracks"]), "first_segment_bytes": size,
                    "first_source_pts": first_source, "seek_source_pts": seek_source,
                    "generations": [1, expected_generation],
                    "old_generation_http_status": old_status,
                    "seek_target": target, "cached_seek": not window_seek,
                    "unauthenticated_hls_http_status": 401,
                    "endlist_verified": True,
                    "initial_fragments": initial_fragments, "seek_fragments": seek_fragments,
                }
            capabilities = (await expect(client, "GET", "/settings/playback/capabilities")).json()
            assert capabilities["available"] and capabilities["encoder"] == "libx264"
            evidence["capabilities"] = capabilities
            evidence["cookie_login"] = True
            evidence["hls_segments_decoded_by_ffmpeg"] = True
            evidence["subtitle_webvtt"] = True
        return evidence
    finally:
        await manager.shutdown()
        await shutdown_probes()
        server.should_exit = True
        await asyncio.wait_for(server_task, 10)


async def main(work: Path) -> int:
    if not sys.platform.startswith("linux"):
        raise SystemExit("此脚本仅在专有 Linux 验证容器内运行")
    work.mkdir(parents=True, exist_ok=True)
    results = []
    for name, check in [
        ("owned_process_suspend_resume_close", verify_owned_process),
        ("owned_process_parent_death", verify_parent_death),
        ("synthetic_samples", generate_samples),
        ("cookie_authenticated_hls_seek_silent_probe_api", verify_cookie_hls_api),
    ]:
        started = time.monotonic()
        try:
            evidence = await check(work)
            result = {"name": name, "passed": True, "seconds": round(time.monotonic() - started, 3),
                      "evidence": evidence}
        except Exception as error:  # noqa: BLE001 记录失败后继续其他独立验收项目。
            result = {"name": name, "passed": False,
                      "seconds": round(time.monotonic() - started, 3),
                      "error": f"{type(error).__name__}: {error}",
                      "traceback": traceback.format_exc()}
        results.append(result)
        print(json.dumps(result, ensure_ascii=False), flush=True)
        (work / "linux-validation.json").write_text(
            json.dumps({"platform": sys.platform, "checks": results}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    return int(any(not item["passed"] for item in results))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--work", type=Path, default=Path("/validation"))
    parser.add_argument("--orphan-parent", type=Path)
    args = parser.parse_args()
    sys.path.insert(0, "/app")
    if args.orphan_parent:
        orphan_parent(args.orphan_parent)
    else:
        work_root = args.work.resolve()
        os.environ.update({
            "MOONCELL_DATABASE_URL": f"sqlite+aiosqlite:///{work_root / 'validation.db'}",
            "MOONCELL_SECRET_KEY": "synthetic-linux-validation-only-no-real-data",
            "MOONCELL_MEDIA_LIBRARY_ROOT": str(work_root / "library"),
            "MOONCELL_PLAYBACK_CACHE_PATH": str(work_root / "cache"),
            "MOONCELL_PLAYBACK_MIN_FREE_MB": "0",
            "MOONCELL_PLAYBACK_ENCODER": "libx264",
        })
        # 显式增加镜像应用路径，脚本通过只读 bind mount 挂在镜像应用目录外。
        with contextlib.suppress(KeyboardInterrupt):
            raise SystemExit(asyncio.run(main(work_root)))
