"""Mikan Project RSS 的频道级元数据规范化规则。"""

import re
from urllib.parse import urlparse

MIKAN_TITLE_PREFIX = re.compile(r"^\s*Mikan\s+Project\s*-\s*", re.IGNORECASE)


def is_mikan_feed(url: str, channel_title: str = "") -> bool:
    """根据主机名或频道标题判断是否为 Mikan 系列 RSS。"""
    hostname = (urlparse(url).hostname or "").lower()
    return "mikan" in hostname or bool(MIKAN_TITLE_PREFIX.match(channel_title))


def normalize_mikan_channel_title(channel_title: str) -> str:
    """删除 Mikan 固定频道前缀，返回适合作为番剧名称的标题。"""
    normalized = MIKAN_TITLE_PREFIX.sub("", channel_title, count=1).strip()
    return normalized or channel_title.strip()
