"""单 worker 中播放与媒体迁移的互斥登记；不持有数据库事务。"""

from collections import Counter

_readers: Counter[int] = Counter()
_mutating: set[int] = set()


def ensure_source_available(source_id: int | None) -> None:
    if source_id in _mutating:
        from .media import MediaError

        raise MediaError("media_migrating", "作品文件正在迁移，请稍后重新播放", 409)


def acquire_source(source_id: int | None) -> None:
    if source_id is None:
        return
    ensure_source_available(source_id)
    _readers[source_id] += 1


def release_source(source_id: int | None) -> None:
    if source_id is None:
        return
    _readers[source_id] -= 1
    if _readers[source_id] <= 0:
        _readers.pop(source_id, None)


def retain_source(source_id: int) -> None:
    """已有播放会话派生响应租约；迁移等待期间仍可完成现有读取。"""
    if not _readers[source_id]:
        from .media import MediaError

        raise MediaError("session_closed", "播放会话已释放媒体文件", 410)
    _readers[source_id] += 1


def begin_mutation(source_id: int | None) -> bool:
    """先阻止新播放，再判断已有会话是否已全部释放。"""
    if source_id is None:
        return True
    _mutating.add(source_id)
    return not _readers[source_id]


def finish_mutation(source_id: int | None) -> None:
    _mutating.discard(source_id)


def source_in_use(source_id: int | None) -> bool:
    return bool(_readers[source_id])
