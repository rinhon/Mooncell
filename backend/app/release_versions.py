"""在相同发布规格内比较修订号，不把发布时间当作升级依据。"""

import json
import re

from sqlalchemy import select

from .models import DomainEvent, DownloadJob, FeedItem
from .release_parser import parse_release_title
from .schemas import ParsedRelease


def release_identity(item, source, parsed=None):
    parsed = parsed or ParsedRelease.model_validate_json(item.parse_data)
    season = parsed.season if "manual_review" in parsed.evidence else (
        source.season if source.season is not None else parsed.season
    )
    if (parsed.release_kind != "single" or parsed.media_type != "episode"
            or parsed.episode_start is None or season is None or not parsed.title
            or not parsed.release_group or not parsed.resolution
            or not parsed.subtitle_languages):
        return None
    # 内嵌、内封、外挂是不同发布规格，不能只凭语言相同就互相替换。
    mode = re.findall(r"内嵌|內嵌|内封|內封|外挂|外掛", item.title)
    mode = tuple(sorted({m.replace("內", "内").replace("掛", "挂") for m in mode}))
    # 人工修改的是媒体库名称；作品身份仍取原始发布标题，保持新旧版可比较。
    title = parse_release_title(item.title).title or parsed.title
    return (item.source_id, title.casefold(), season, parsed.media_type,
            parsed.episode_start, parsed.release_group.casefold(), parsed.resolution,
            tuple(sorted(parsed.subtitle_languages)), mode)


async def select_revisions(session, source, items):
    """首次导入仅投递最高版；已投递旧版保留到替换事务完成。"""
    jobs = {j.item_id: j for j in await session.scalars(
        select(DownloadJob).join(FeedItem).where(FeedItem.source_id == source.id)
    )}
    groups = {}
    chosen = []
    for item in items:
        parsed = ParsedRelease.model_validate_json(item.parse_data)
        key = release_identity(item, source, parsed)
        if key is None:
            chosen.append(item)
        else:
            groups.setdefault(key, []).append((item, parsed.revision))
    for entries in groups.values():
        # 相同修订号优先复用已有任务，否则稳定地选最早入库的一条。
        winner, revision = max(entries, key=lambda pair: (
            pair[1], pair[0].id in jobs, -pair[0].id,
        ))
        chosen.append(winner)
        for item, old_revision in entries:
            if item.id == winner.id:
                continue
            job = jobs.get(item.id)
            if job is None or job.state == "queued":
                item.parse_status = "superseded"
                if job:
                    job.state = "superseded"
                session.add(DomainEvent(
                    event_type="download.superseded", resource_type="feed_item",
                    resource_id=str(item.id), payload=json.dumps({
                        "title": item.title, "replacement_id": winner.id, "revision": revision,
                    }, ensure_ascii=False),
                ))
    return chosen
