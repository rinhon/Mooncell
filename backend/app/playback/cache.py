"""已原子发布的分片登记、读取保护与专有缓存配额。"""

import math
import os
import re
import shutil
import time
from dataclasses import dataclass
from pathlib import Path

from .media import MediaError

SEGMENT_NAME = re.compile(r"segment-(\d{7})\.ts\Z")
SESSION_NAME = re.compile(r"session-[a-f0-9]{32}\Z")
MARKER = ".mooncell-playback"
RESERVE_BYTES = 8 * 1024 * 1024  # 3 秒、6 Mbps 上限外，预留检测与封装余量。


class CacheLock:
    """同一缓存根只属于一个后端 worker；进程退出自动释放内核文件锁。"""

    def __init__(self, root: Path):
        root.mkdir(parents=True, exist_ok=True)
        self.file = (root / ".worker.lock").open("a+b")
        try:
            self.file.seek(0, 2)
            if self.file.tell() == 0:
                self.file.write(b"\0")
                self.file.flush()
            self.file.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(self.file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            self.file.close()
            raise RuntimeError(
                "播放缓存已由其他后端进程使用。播放服务只支持单 worker；"
                "请关闭重复实例，或为独立实例配置不同的 PLAYBACK_CACHE_PATH。"
            ) from exc

    def close(self) -> None:
        if self.file.closed:
            return
        self.file.seek(0)
        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(self.file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(self.file.fileno(), fcntl.LOCK_UN)
        finally:
            self.file.close()


@dataclass
class Segment:
    sequence: int
    path: Path
    source_start: float
    duration: float
    published_at: float
    readers: int = 0
    last_access: float = 0


def session_directory(root: Path, session_id: str) -> Path:
    name = f"session-{session_id}"
    if not SESSION_NAME.fullmatch(name):
        raise ValueError("无效的专有缓存名称")
    root.mkdir(parents=True, exist_ok=True)
    directory = root / name
    directory.mkdir(exist_ok=True)
    (directory / MARKER).touch()
    return directory


def remove_owned(root: Path, directory: Path) -> None:
    # 必须同时通过父目录、名称与自有标记，绝不按进程名或任意路径回收。
    if (directory.is_symlink() or directory.is_junction()
            or directory.resolve().parent != root.resolve()
            or not SESSION_NAME.fullmatch(directory.name)
            or not (directory / MARKER).is_file()):
        return
    shutil.rmtree(directory)


def directory_bytes(directory: Path) -> int:
    try:
        return sum(path.stat().st_size for path in directory.rglob("*")
                   if path.is_file() and not path.is_symlink())
    except OSError:
        return 0


def playlist_entries(path: Path) -> tuple[list[tuple[int, str, float]], bool]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError):
        return [], False
    duration = None
    entries = []
    for line in lines:
        if line.startswith("#EXTINF:"):
            try:
                duration = float(line.partition(":")[2].split(",")[0])
            except ValueError:
                duration = None
        elif match := SEGMENT_NAME.fullmatch(line):
            if duration is not None and math.isfinite(duration) and 0 < duration < 30:
                entries.append((int(match[1]), line, duration))
            duration = None
    return entries, "#EXT-X-ENDLIST" in lines


def prune(segments: dict[int, Segment], position: float, grace: float = 15) -> None:
    now = time.monotonic()
    # HLS 的 MEDIA-SEQUENCE 要求清单序号连续；在读的最旧片段必须连同后缀保留。
    for sequence, segment in sorted(segments.items()):
        if (segment.source_start + segment.duration < position - 60 and segment.readers == 0
                and now - max(segment.published_at, segment.last_access) > grace):
            try:
                segment.path.unlink(missing_ok=True)
            except OSError:
                break
            del segments[sequence]
        else:
            break


def playable_segments(segments: dict[int, Segment]) -> list[Segment]:
    values = sorted(segments.values(), key=lambda segment: segment.sequence)
    # 旧分片可能仍因在途响应保留，但清单不能把序号中间的空洞拼接起来。
    start = 0
    for index in range(1, len(values)):
        if values[index].sequence != values[index - 1].sequence + 1:
            start = index
    return values[start:]


def make_playlist(segments: dict[int, Segment], ended: bool) -> str:
    values = playable_segments(segments)
    if not values:
        raise MediaError("session_preparing", "播放分片仍在准备中", 425)
    target = max(1, math.ceil(max(segment.duration for segment in values)))
    lines = ["#EXTM3U", "#EXT-X-VERSION:6", f"#EXT-X-TARGETDURATION:{target}",
             f"#EXT-X-MEDIA-SEQUENCE:{values[0].sequence}", "#EXT-X-INDEPENDENT-SEGMENTS"]
    for segment in values:
        lines += [f"#EXTINF:{segment.duration:.6f},", f"segments/{segment.path.name}"]
    if ended:
        lines.append("#EXT-X-ENDLIST")
    return "\n".join(lines) + "\n"
