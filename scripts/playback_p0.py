r"""真实 FFmpeg / Windows 进程控制诊断；输出仅写入专用目录。

PowerShell:
  & backend\.venv\Scripts\python.exe scripts\playback_p0.py

需要 psutil。未安装时可通过 --dependency-dir 指定隔离安装目录。
所有进程均由此脚本创建，不按进程名查找、暂停或终止其他程序。
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from collections import deque
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run(command: list[str], *, timeout: float = 90) -> dict:
    started = time.monotonic()
    completed = subprocess.run(
        command, capture_output=True, text=True, timeout=timeout, check=False,
    )
    return {
        "command": command,
        "seconds": round(time.monotonic() - started, 3),
        "returncode": completed.returncode,
        "stdout": completed.stdout,
        "stderr_tail": completed.stderr[-8000:],
    }


def require(result: dict) -> dict:
    if result["returncode"]:
        raise RuntimeError(json.dumps(result, ensure_ascii=False))
    return result


def run_hls(command: list[str], directory: Path) -> dict:
    result = {}

    def execute():
        result.update(run(command))

    started = time.monotonic()
    worker = threading.Thread(target=execute)
    worker.start()
    first_segment = None
    while worker.is_alive():
        if first_segment is None and any(directory.glob("*.ts")):
            first_segment = round(time.monotonic() - started, 3)
        worker.join(timeout=0.02)
    result["first_segment_seconds"] = first_segment or result.get("seconds")
    return require(result)


def probe(path: Path, *, selector: str | None = None, packets: bool = False) -> dict:
    command = ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json"]
    if selector:
        command += ["-select_streams", selector]
    if packets:
        command += ["-show_packets", "-read_intervals", "%+#3"]
    return json.loads(require(run([*command, str(path)]))["stdout"])


def transcode_command(source: Path, directory: Path, seek: float = 0) -> list[str]:
    """3 秒关键帧、原子发布、有限清单；删除由正式缓存管理器控制。"""
    coarse = max(0, seek - 30) if source.suffix.lower() == ".ts" else seek
    return [
        "ffmpeg", "-hide_banner", "-loglevel", "warning", "-nostdin", "-y",
        "-threads", "4", "-copyts", "-start_at_zero", "-ss", str(coarse),
        "-protocol_whitelist", "file,pipe",
        "-i", str(source), "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn",
        "-vf", f"trim=start={seek}", "-af", f"atrim=start={seek}",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-threads", "4",
        "-pix_fmt", "yuv420p", "-sc_threshold", "0", "-bf", "0",
        "-force_key_frames", "expr:if(isnan(prev_forced_t),1,gte(t,prev_forced_t+3))",
        "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000",
        "-avoid_negative_ts", "disabled", "-f", "hls", "-hls_time", "3",
        "-hls_list_size", "3",
        "-hls_segment_type", "mpegts",
        "-hls_flags", "temp_file+independent_segments",
        "-hls_segment_options", "mpegts_copyts=1:output_ts_offset=1",
        "-hls_segment_filename", str(directory / "segment-%05d.ts"),
        str(directory / "index.m3u8"),
    ]


def process_validation(output: Path) -> dict:
    import psutil

    command = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostats", "-re", "-f",
        "lavfi", "-i", "testsrc2=size=320x180:rate=24", "-t", "30", "-progress",
        "pipe:1", "-f", "null", "-",
    ]
    child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True, bufsize=1)
    owned = psutil.Process(child.pid)
    progress: list[int] = []
    errors: deque[str] = deque(maxlen=20)

    def read_progress() -> None:
        assert child.stdout
        for line in child.stdout:
            if line.startswith("out_time_us=") and line.strip().split("=")[1].isdigit():
                progress.append(int(line.strip().split("=")[1]))

    def read_errors() -> None:
        assert child.stderr
        errors.extend(child.stderr)

    readers = [threading.Thread(target=read_progress, daemon=True),
               threading.Thread(target=read_errors, daemon=True)]
    for reader in readers:
        reader.start()
    try:
        time.sleep(1.8)
        owned.suspend()
        time.sleep(0.3)  # 允许已写入管道的数据被读取。
        paused_start = progress[-1]
        time.sleep(1.6)
        paused_end = progress[-1]
        owned.resume()
        time.sleep(1.8)
        resumed_end = progress[-1]
        owned.suspend()
        owned.resume()  # 已挂起退出：先恢复，再向自己创建的 FFmpeg 写 q。
        assert child.stdin
        child.stdin.write("q\n")
        child.stdin.flush()
        graceful_code = child.wait(timeout=5)
    finally:
        if child.poll() is None:
            owned.resume()
            child.kill()
            child.wait(timeout=5)
        for reader in readers:
            reader.join(timeout=2)
    terminating = subprocess.Popen(command, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
    time.sleep(0.4)
    psutil.Process(terminating.pid).terminate()
    terminate_code = terminating.wait(timeout=5)
    result = {
        "psutil_version": psutil.__version__, "pause_before_us": paused_start,
        "pause_after_us": paused_end, "after_resume_us": resumed_end,
        "paused_output_stopped": paused_start == paused_end,
        "resume_advanced": resumed_end > paused_end, "graceful_exit_code": graceful_code,
        "terminate_exit_code": terminate_code, "stderr_tail": list(errors),
    }
    (output / "process.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    assert result["paused_output_stopped"] and result["resume_advanced"]
    assert graceful_code == 0
    return result


def create_windows_job():
    """无继承 Job 句柄；最后一个句柄关闭时由内核回收所属进程。"""
    from ctypes import wintypes

    class BasicLimit(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64),
                    ("PerJobUserTimeLimit", ctypes.c_int64), ("LimitFlags", wintypes.DWORD),
                    ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t),
                    ("ActiveProcessLimit", wintypes.DWORD), ("Affinity", ctypes.c_size_t),
                    ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]

    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint64) for name in (
            "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
            "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class ExtendedLimit(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", BasicLimit), ("IoInfo", IoCounters),
                    ("ProcessMemoryLimit", ctypes.c_size_t),
                    ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t),
                    ("PeakJobMemoryUsed", ctypes.c_size_t)]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int,
                                              ctypes.c_void_p, wintypes.DWORD]
    kernel.SetInformationJobObject.restype = wintypes.BOOL
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    job = kernel.CreateJobObjectW(None, None)
    if not job:
        raise ctypes.WinError(ctypes.get_last_error())
    limits = ExtendedLimit()
    limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
        kernel.CloseHandle(job)
        raise ctypes.WinError(ctypes.get_last_error())
    return kernel, job


def job_child(marker: Path) -> None:
    """独立的模拟后端，等待外部强制终止；不走 finally。"""
    import psutil

    kernel, job = create_windows_job()
    child = subprocess.Popen(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i",
         "testsrc2=size=320x180:rate=24", "-t", "120", "-f", "null", "-"],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=0x00000004,  # CREATE_SUSPENDED，先加入 Job 再运行，消除退出竞态。
        close_fds=True,
    )
    try:
        if not kernel.AssignProcessToJobObject(job, int(child._handle)):
            raise ctypes.WinError(ctypes.get_last_error())
        psutil.Process(child.pid).resume()
        marker.write_text(json.dumps({"parent_pid": os.getpid(), "child_pid": child.pid}),
                          encoding="utf-8")
        time.sleep(90)
    finally:
        kernel.CloseHandle(job)
        child.wait(timeout=5)


def job_validation(output: Path, dependency_dir: Path) -> dict:
    if os.name != "nt":
        return {"tested": False, "reason": "Windows Job Object 仅限 Windows"}
    import psutil

    marker = output / "job-child.json"
    parent = subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), "--job-child", str(marker),
         "--dependency-dir", str(dependency_dir)], stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True,
    )
    try:
        deadline = time.monotonic() + 10
        while not marker.exists() and time.monotonic() < deadline and parent.poll() is None:
            time.sleep(0.1)
        if not marker.exists():
            stdout, stderr = parent.communicate(timeout=5)
            raise RuntimeError(f"Job setup failed: {stdout}\n{stderr}")
        ids = json.loads(marker.read_text(encoding="utf-8"))
        child = psutil.Process(ids["child_pid"])
        assert child.is_running()
        started = time.monotonic()
        parent.kill()  # 模拟后端崩溃，绕过 Python finally。
        parent.wait(timeout=5)
        child.wait(timeout=5)
        return {"tested": True, "abnormal_parent_exit_reaped_child": True,
                "reap_seconds": round(time.monotonic() - started, 3), **ids}
    finally:
        if parent.poll() is None:
            parent.kill()
            parent.wait(timeout=5)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "backend/data/playback-p0")
    parser.add_argument("--dependency-dir", type=Path,
                        default=ROOT / "backend/data/playback-p0/deps")
    parser.add_argument("--job-child", type=Path)
    options = parser.parse_args()
    if options.dependency_dir.exists():
        sys.path.insert(0, str(options.dependency_dir.resolve()))
    if options.job_child:
        job_child(options.job_child)
        return 0
    for executable in ("ffmpeg", "ffprobe"):
        if not shutil.which(executable):
            raise RuntimeError(f"{executable} 不在 PATH")
    output = options.output.resolve() / time.strftime("run-%Y%m%d-%H%M%S")
    output.mkdir(parents=True, exist_ok=False)
    report: dict = {"platform": sys.platform, "output": str(output),
                    "ffmpeg": require(run(["ffmpeg", "-version"]))["stdout"].splitlines()[0]}
    source = output / "source-h264-aac-720p24.mp4"
    report["sample"] = require(run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
        "testsrc2=size=1280x720:rate=24", "-f", "lavfi", "-i",
        "sine=frequency=1000:sample_rate=48000", "-t", "24", "-c:v", "libx264",
        "-preset", "ultrafast", "-crf", "27", "-threads", "4", "-g", "120",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", str(source)]))
    report["hls"] = []
    for seek in (0, 7.3):
        directory = output / f"hls-{seek}"
        directory.mkdir()
        transcode = run_hls(transcode_command(source, directory, seek), directory)
        segments = []
        for segment in sorted(directory.glob("*.ts")):
            video = probe(segment, selector="v:0", packets=True)
            audio = probe(segment, selector="a:0", packets=True)
            segments.append({"name": segment.name, "bytes": segment.stat().st_size,
                             "video": video, "audio": audio})
        report["hls"].append({"seek": seek, "transcode": transcode,
                              "playlist": (directory / "index.m3u8").read_text(),
                              "segments": segments})
        print(f"HLS seek={seek}: {len(segments)} completed segments", flush=True)
    report["matrix"] = []
    for name, size, fps, codec in (
        ("hevc-1080p-2997", "1920x1080", "30000/1001", "libx265"),
        ("noaudio-720p-23976", "1280x720", "24000/1001", "libx264"),
    ):
        sample = output / f"{name}.mkv"
        arguments = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
            f"testsrc2=size={size}:rate={fps}", "-t", "6", "-c:v", codec, "-preset",
            "ultrafast", "-threads", "4", "-an",
        ]
        if codec == "libx265":
            arguments += ["-x265-params", "pools=4:log-level=error"]
        generation = require(run([*arguments, str(sample)]))
        directory = output / name
        directory.mkdir()
        transcoding = run_hls(transcode_command(sample, directory), directory)
        report["matrix"].append({
            "name": name, "generate": generation, "transcode": transcoding,
            "playlist": (directory / "index.m3u8").read_text(),
            "first_segment": probe(min(directory.glob("*.ts"))),
        })
        print(f"Matrix {name}: {transcoding['seconds']}s", flush=True)
    nonzero = output / "source-nonzero-start.ts"
    require(run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(source),
        "-c", "copy", "-output_ts_offset", "5", "-muxdelay", "0", str(nonzero),
    ]))
    report["nonzero_start"] = {"source_probe": probe(nonzero), "seeks": []}
    for seek in (0, 7.3):
        directory = output / f"nonzero-start-seek-{seek}"
        directory.mkdir()
        timing = run_hls(transcode_command(nonzero, directory, seek), directory)
        report["nonzero_start"]["seeks"].append({
            "seek": seek, "transcode": timing,
            "first_segment": probe(min(directory.glob("*.ts"))),
        })
    report["hardware"] = []
    for encoder in ("libx264", "h264_nvenc", "h264_qsv", "h264_amf", "h264_mf"):
        result = run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
            "testsrc2=size=1280x720:rate=24", "-t", "1", "-an", "-c:v", encoder,
            "-pix_fmt", "yuv420p", "-threads", "4", str(output / f"{encoder}.mp4")],
            timeout=30)
        result["encoder"] = encoder
        if result["returncode"] == 0:
            result["probe"] = probe(output / f"{encoder}.mp4")
        report["hardware"].append(result)
        print(f"Encoder {encoder}: code={result['returncode']}", flush=True)
    report["process"] = process_validation(output)
    report["job"] = job_validation(output, options.dependency_dir)
    destination = output / "report.json"
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"report": str(destination), "process": report["process"],
                      "job": report["job"]}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
