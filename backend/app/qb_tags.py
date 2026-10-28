"""只同步 Mooncell 管理的番剧标签，保留下载器中的其他标签。"""


def show_tag(title):
    # qB 的标签接口以英文逗号分隔；番名里的逗号不能拆成多个标签。
    tag = " ".join(title.replace(",", "，").split())
    if not tag:
        raise ValueError("番剧名称不能为空，无法生成 qB 标签")
    return tag


async def sync_show_tag(client, info_hash, torrent, title, previous=None):
    """每轮最多提交一个操作，下一轮读取确认；旧标签必须来自持久化记录。"""
    from .download_queue import request

    desired = show_tag(title)
    tags = {tag.strip() for tag in str(torrent.get("tags", "")).split(",") if tag.strip()}
    if desired not in tags:
        await request(
            client,
            "POST",
            "torrents/addTags",
            data={
                "hashes": info_hash,
                "tags": desired,
            },
        )
        return False
    if previous and previous != desired and previous in tags and "," not in previous:
        await request(
            client,
            "POST",
            "torrents/removeTags",
            data={
                "hashes": info_hash,
                "tags": previous,
            },
        )
        return False
    return True
