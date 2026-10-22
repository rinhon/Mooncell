"""仅控制本服务创建的 FFmpeg，退出保护由操作系统持有。"""

from __future__ import annotations

import asyncio
import ctypes
import os
import signal
import subprocess
import sys
import threading
import time
from collections import deque

import psutil


class WindowsJob:
    def __init__(self):
        from ctypes import wintypes

        class Basic(ctypes.Structure):
            _fields_ = [("process_time", ctypes.c_int64), ("job_time", ctypes.c_int64),
                        ("flags", wintypes.DWORD), ("min_ws", ctypes.c_size_t),
                        ("max_ws", ctypes.c_size_t), ("active", wintypes.DWORD),
                        ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD),
                        ("scheduling", wintypes.DWORD)]

        class Extended(ctypes.Structure):
            _fields_ = [("basic", Basic), ("io", ctypes.c_uint64 * 6),
                        ("process_memory", ctypes.c_size_t), ("job_memory", ctypes.c_size_t),
                        ("peak_process", ctypes.c_size_t), ("peak_job", ctypes.c_size_t)]

        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        self.kernel.CreateJobObjectW.restype = wintypes.HANDLE
        self.kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int,
                                                       ctypes.c_void_p, wintypes.DWORD]
        self.kernel.SetInformationJobObject.restype = wintypes.BOOL
        self.kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        self.kernel.AssignProcessToJobObject.restype = wintypes.BOOL
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel.CloseHandle.restype = wintypes.BOOL
        self.handle = self.kernel.CreateJobObjectW(None, None)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        limits = Extended()
        limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not self.kernel.SetInformationJobObject(
            self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits),
        ):
            self.close()
            raise ctypes.WinError(ctypes.get_last_error())

    def assign(self, process: subprocess.Popen) -> None:
        if not self.kernel.AssignProcessToJobObject(self.handle, int(process._handle)):
            raise ctypes.WinError(ctypes.get_last_error())

    def close(self) -> None:
        if self.handle:
            self.kernel.CloseHandle(self.handle)
            self.handle = None


class OwnedProcess:
    def __init__(self):
        self.process: subprocess.Popen | None = None
        self.job: WindowsJob | None = None
        self.suspended = False
        self.out_time = 0.0
        self.last_progress = time.monotonic()
        self.stderr: deque[str] = deque(maxlen=40)
        self._readers: list[threading.Thread] = []

    def start(self, command: list[str]) -> None:
        flags = 0
        if os.name == "nt":
            self.job = WindowsJob()
            flags = 0x00000004 | subprocess.CREATE_NO_WINDOW  # CREATE_SUSPENDED
        elif sys.platform.startswith("linux"):
            command = [sys.executable, "-m", "app.playback.processes", str(os.getpid()),
                       "--", *command]
        try:
            self.process = subprocess.Popen(
                command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, encoding="utf-8", errors="replace", bufsize=1, close_fds=True,
                creationflags=flags,
            )
            if self.job:
                self.job.assign(self.process)
                psutil.Process(self.process.pid).resume()
        except BaseException:
            if self.process is not None:
                self.process.kill()
                self.process.wait(timeout=5)
            if self.job:
                self.job.close()
            raise
        self._readers = [threading.Thread(target=self._stdout, daemon=True),
                         threading.Thread(target=self._stderr, daemon=True)]
        for reader in self._readers:
            reader.start()

    def _stdout(self) -> None:
        assert self.process and self.process.stdout
        for line in self.process.stdout:
            if line.startswith("out_time_us="):
                try:
                    self.out_time = float(line.partition("=")[2]) / 1_000_000
                    self.last_progress = time.monotonic()
                except ValueError:
                    pass

    def _stderr(self) -> None:
        assert self.process and self.process.stderr
        for line in self.process.stderr:
            self.stderr.append(line[-2048:].rstrip())

    @property
    def returncode(self) -> int | None:
        return self.process.poll() if self.process else None

    @property
    def running(self) -> bool:
        return self.process is not None and self.process.poll() is None

    def suspend(self) -> None:
        if self.running and not self.suspended:
            psutil.Process(self.process.pid).suspend()
            self.suspended = True

    def resume(self) -> None:
        if self.running and self.suspended:
            psutil.Process(self.process.pid).resume()
            self.suspended = False
            self.last_progress = time.monotonic()

    async def stop(self) -> None:
        if self.process is None:
            return
        try:
            self.resume()
            if self.running:
                try:
                    self.process.stdin.write("q\n")
                    self.process.stdin.flush()
                except (OSError, ValueError):
                    pass
                try:
                    await asyncio.to_thread(self.process.wait, timeout=3)
                except subprocess.TimeoutExpired:
                    self.process.terminate()
                    try:
                        await asyncio.to_thread(self.process.wait, timeout=2)
                    except subprocess.TimeoutExpired:
                        self.process.kill()
                        await asyncio.to_thread(self.process.wait, timeout=5)
            else:
                self.process.wait()
        finally:
            if self.job:
                self.job.close()
            for reader in self._readers:
                await asyncio.to_thread(reader.join, 1)
            for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
                if stream:
                    stream.close()


def _linux_exec() -> None:
    parent_pid = int(sys.argv[1])
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:  # PR_SET_PDEATHSIG
        raise OSError(ctypes.get_errno(), "设置父进程退出保护失败")
    if os.getppid() != parent_pid:
        raise SystemExit(1)
    command = sys.argv[3:]
    os.execvp(command[0], command)


if __name__ == "__main__":
    _linux_exec()
