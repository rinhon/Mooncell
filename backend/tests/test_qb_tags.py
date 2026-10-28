from urllib.parse import parse_qs

import httpx
import pytest

from app.qb_tags import show_tag, sync_show_tag


@pytest.mark.parametrize(
    "title, expected",
    [
        ("番剧名称", "番剧名称"),
        ("  Hello, World  ", "Hello， World"),
        ("番名\r\n\t第二季", "番名 第二季"),
    ],
)
def test_title_produces_one_tag(title, expected):
    assert show_tag(title) == expected


def test_blank_title_is_rejected():
    with pytest.raises(ValueError, match="不能为空"):
        show_tag(" \n ")


@pytest.mark.parametrize("previous", [None, "", "旧番名", "旧番名, 手动标签"])
async def test_add_before_remove_and_confirm_preserves_other_tags(previous):
    torrent = {"tags": "旧番名, 手动标签"}
    calls = []

    def handle(request):
        data = {key: values[0] for key, values in parse_qs(request.content.decode()).items()}
        endpoint = request.url.path.rsplit("/", 1)[-1]
        calls.append((endpoint, data))
        assert data["hashes"] == "a" * 40
        assert data["tags"] and "," not in data["tags"]
        tags = set(torrent["tags"].split(", "))
        if endpoint == "addTags":
            tags.add(data["tags"])
        elif endpoint == "removeTags":
            tags.remove(data["tags"])
        else:
            pytest.fail("must only add/remove torrent tags")
        torrent["tags"] = ", ".join(sorted(tags))
        return httpx.Response(200)

    async with httpx.AsyncClient(
        base_url="http://qb.test", transport=httpx.MockTransport(handle)
    ) as client:
        for _ in range(4):
            if await sync_show_tag(client, "a" * 40, torrent, "新番名, 第二季", previous):
                break
        else:
            pytest.fail("tags did not settle")
    assert calls[0][0] == "addTags"
    expected = {"手动标签", "新番名， 第二季"}
    if previous != "旧番名":
        expected.add("旧番名")
        assert len(calls) == 1
    else:
        assert calls[1][0] == "removeTags"
    assert set(torrent["tags"].split(", ")) == expected
