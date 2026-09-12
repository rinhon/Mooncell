from app.providers.mikan import is_mikan_feed, normalize_mikan_channel_title
from app.rss_service import parse_feed_metadata


def test_normalize_mikan_channel_title() -> None:
    assert (
        normalize_mikan_channel_title("Mikan Project - 同一个研讨会的染谷同学是AV女优的事")
        == "同一个研讨会的染谷同学是AV女优的事"
    )


def test_mikan_feed_metadata_uses_channel_title() -> None:
    content = """<?xml version="1.0" encoding="utf-8"?>
    <rss version="2.0"><channel>
      <title>Mikan Project - 同一个研讨会的染谷同学是AV女优的事</title>
      <item><title>[ANi] Example - 01 [1080P]</title></item>
    </channel></rss>""".encode()
    result = parse_feed_metadata(
        content,
        "https://mikan.example/RSS/Bangumi?bangumiId=4040&amp;subgroupid=203",
    )
    assert result.raw_title == "Mikan Project - 同一个研讨会的染谷同学是AV女优的事"
    assert result.name == "同一个研讨会的染谷同学是AV女优的事"
    assert result.kind == "mikan"
    assert result.entries == 1


def test_mikan_detection_by_title_or_hostname() -> None:
    assert is_mikan_feed("https://mikan.example/rss")
    assert is_mikan_feed("https://rss.example/feed", "Mikan Project - Example")
