import json
import ssl
from datetime import datetime

import httpx
import pytest

from app import calendar_service as service


@pytest.fixture
def recorded(monkeypatch):
    events = []

    async def record(event_type, season, **payload):
        events.append((event_type, season, payload))

    monkeypatch.setattr(service, "record_calendar_event", record)
    return events


@pytest.mark.parametrize(
    ("month", "expected"),
    [
        (1, "202601"),
        (3, "202601"),
        (4, "202604"),
        (6, "202604"),
        (7, "202607"),
        (9, "202607"),
        (10, "202610"),
        (12, "202610"),
    ],
)
def test_quarters(month, expected):
    assert service.current_season(datetime(2026, month, 1)) == expected
    assert service.current_season(datetime(2027, 1, 1)) == "202701"


def test_parse_lazy_images_weekdays_and_extended_times():
    html = """<div class="post-body"><td class="date2">周日 (日)</td>
    <div><div class="div_date"><a href="/cover.jpg"><img data-src="//i0.hdslb.com/a.jpg"></a>
    <p class="imgtext5">25:00~</p></div><table><tr><td class="date_title_">番名<br>第2期</td>
    </tr></table></div><td class="date2">网络放送 &amp; 其他</td>
    <div><div class="div_date"><img src="/b.jpg"></div>
    <table><tr><td>网络番剧</td></tr></table></div></div>"""
    items = service.parse_calendar(html, "202607")
    assert len(items) == 2
    assert items[0]["title"] == "番名 第2期"
    assert items[0]["weekday"] == 6
    assert items[0]["broadcast_time"] == "25:00~"
    assert items[0]["cover_source"] == "https://i0.hdslb.com/a.jpg"
    assert items[1]["weekday"] is None
    assert items[1]["broadcast_time"] == "时间待定"


@pytest.mark.parametrize("time_class", ["pmfs", "pmfs2"])
def test_parse_other_broadcast_cards_and_dates(time_class):
    html = f'''<div class="post-body"><td class="date2">周日 (日)</td>
    <div><div class="div_date"><p class="imgtext5">25:00~</p></div>
    <table><tr><td class="date_title_">周日番剧</td></tr></table></div>
    <td class="date2">网络放送 &amp; 其他</td><div>
    <div><div class="div_date_"><img data-src="//i0.hdslb.com/other.jpg"></div>
    <div><table><tr><td class="date_title__">网络番剧<br>第2期</td></tr>
    <tr><td><p class="area">环大陆</p><p class="{time_class}">10/20网络放送</p>
    <p class="{time_class}">10/20网络放送</p><p class="{time_class}">11/6追加放送</p>
    <p class="pmex">(全10话)</p></td></tr></table></div></div>
    <div><div class="div_date_"><img src="/pending.jpg"></div>
    <div><table><tr><td class="date_title_">未定档番剧</td></tr></table></div></div>
    </div><div class="future_date">下季预告</div></div>'''
    items = service.parse_calendar(html, "202610")
    assert len(items) == 3
    assert items[0]["weekday"] == 6
    assert items[0]["broadcast_time"] == "25:00~"
    assert items[1] == {
        "id": 2,
        "title": "网络番剧 第2期",
        "weekday": None,
        "broadcast_time": "10/20网络放送 / 11/6追加放送",
        "cover_source": "https://i0.hdslb.com/other.jpg",
    }
    assert items[2]["weekday"] is None
    assert items[2]["broadcast_time"] == "时间待定"


def test_other_card_does_not_inherit_weekday_without_heading():
    html = """<div class="post-body"><td class="date2">周日</td>
    <div><div class="div_date_"></div>
    <table><tr><td>网络番剧</td></tr></table></div></div>"""
    assert service.parse_calendar(html, "202610")[0]["weekday"] is None


@pytest.mark.parametrize("html", ["<html>404</html>", '<div class="post-body"></div>'])
def test_empty_page_is_not_success(html):
    with pytest.raises(ValueError):
        service.parse_calendar(html, "202607")


async def test_persisted_season_never_fetches(monkeypatch, tmp_path):
    monkeypatch.setattr(service.settings, "calendar_cache_path", str(tmp_path))
    path = tmp_path / "202601"
    path.mkdir()
    data = {
        "season": "202601",
        "cache_version": service.CALENDAR_CACHE_VERSION,
        "items": [{"title": "已缓存"}],
    }
    (path / "season.json").write_text(json.dumps(data), encoding="utf-8")

    def no_network(*args, **kwargs):
        pytest.fail("cached calendar must not access network")

    monkeypatch.setattr(service.httpx, "AsyncClient", no_network)
    assert await service.ensure_season("202601") == data


async def test_legacy_cache_supplements_others_once_preserving_ids_and_covers(
    monkeypatch,
    tmp_path,
    recorded,
):
    monkeypatch.setattr(service.settings, "calendar_cache_path", str(tmp_path))
    monkeypatch.setattr(service, "_failures", {})
    folder = tmp_path / "202601"
    folder.mkdir()
    original = {
        "season": "202601",
        "fetched_at": "2026-01-01T00:00:00+00:00",
        "items": [
            {
                "id": 11,
                "title": "原有周日番剧",
                "weekday": 6,
                "broadcast_time": "25:00~",
                "cover_source": "https://i0.hdslb.com/old.jpg",
            },
            {
                "id": 42,
                "title": "已收录网络番剧",
                "weekday": None,
                "broadcast_time": "时间待定",
                "cover_source": None,
            },
        ],
    }
    path = folder / "season.json"
    path.write_text(json.dumps(original), encoding="utf-8")
    (folder / "11.img").write_bytes(b"original-cover")
    html = """<div class="post-body"><td class="date2">周一</td>
    <div><div class="div_date"></div><table><tr><td>源站新增周番</td></tr></table></div>
    <td class="date2">网络放送 &amp; 其他</td>
    <div><div class="div_date_"></div><table><tr><td>已收录网络番剧</td></tr>
    <tr><td><p class="pmfs">1/20网络放送</p></td></tr></table></div>
    <div><div class="div_date_"><img src="https://i0.hdslb.com/new.jpg"></div>
    <table><tr><td>新增网络番剧</td></tr>
    <tr><td><p class="pmfs2">2/20网络放送</p></td></tr></table></div></div>"""
    original_client = httpx.AsyncClient
    requests = []

    async def respond(request):
        requests.append(str(request.url))
        if request.url.host == "yuc.wiki":
            return httpx.Response(200, text=html)
        return httpx.Response(200, content=b"new-cover", headers={"content-type": "image/jpeg"})

    monkeypatch.setattr(
        service.httpx,
        "AsyncClient",
        lambda **kwargs: original_client(
            transport=httpx.MockTransport(respond),
            **kwargs,
        ),
    )
    result = await service.ensure_season("202601")
    assert result["cache_version"] == service.CALENDAR_CACHE_VERSION
    assert result["fetched_at"] == original["fetched_at"]
    assert result["items"][0] == original["items"][0]
    assert [(item["id"], item["title"]) for item in result["items"]] == [
        (11, "原有周日番剧"),
        (42, "已收录网络番剧"),
        (43, "新增网络番剧"),
    ]
    assert result["items"][1]["broadcast_time"] == "1/20网络放送"
    assert result["items"][2]["broadcast_time"] == "2/20网络放送"
    assert (folder / "11.img").read_bytes() == b"original-cover"
    assert (folder / "43.img").read_bytes() == b"new-cover"
    assert json.loads(path.read_text(encoding="utf-8")) == result
    assert await service.ensure_season("202601") == result
    assert requests == ["https://yuc.wiki/202601/", "https://i0.hdslb.com/new.jpg"]
    assert recorded[-1][0] == "calendar.fetch.completed"


async def test_legacy_cache_is_readable_when_upgrade_fails(monkeypatch, tmp_path, recorded):
    monkeypatch.setattr(service.settings, "calendar_cache_path", str(tmp_path))
    monkeypatch.setattr(service, "_failures", {})
    folder = tmp_path / "202601"
    folder.mkdir()
    original = {"season": "202601", "items": [{"id": 7, "title": "已缓存"}]}
    path = folder / "season.json"
    path.write_text(json.dumps(original), encoding="utf-8")
    calls = []

    async def fail(self, url, **kwargs):
        calls.append(url)
        raise httpx.ConnectError("offline")

    monkeypatch.setattr(httpx.AsyncClient, "get", fail)
    assert await service.ensure_season("202601") == original
    assert await service.ensure_season("202601") == original
    assert json.loads(path.read_text(encoding="utf-8")) == original
    assert len(calls) == 1
    assert recorded[-1][0] == "calendar.fetch.failed"


async def test_failed_fetch_not_cached_and_throttled(monkeypatch, tmp_path, recorded):
    monkeypatch.setattr(service.settings, "calendar_cache_path", str(tmp_path))
    monkeypatch.setattr(service, "_failures", {})
    calls = []

    async def fail(self, url, **kwargs):
        calls.append(url)
        raise httpx.ConnectError("offline")

    monkeypatch.setattr(httpx.AsyncClient, "get", fail)
    with pytest.raises(httpx.ConnectError):
        await service.ensure_season("202601")
    with pytest.raises(ValueError, match="15"):
        await service.ensure_season("202601")
    assert len(calls) == 1
    assert [event[0] for event in recorded] == ["calendar.fetch.started", "calendar.fetch.failed"]
    assert "ConnectError" in recorded[1][2]["error"]
    assert not (tmp_path / "202601" / "season.json").exists()


async def test_certificate_failure_retries_direct_and_persists(monkeypatch, tmp_path, recorded):
    monkeypatch.setattr(service.settings, "calendar_cache_path", str(tmp_path))
    monkeypatch.setattr(service, "_failures", {})
    original_client = httpx.AsyncClient
    options = []
    requests = []
    html = """<div class="post-body"><td class="date2">周一</td>
    <div><div class="div_date"><img src="https://i0.hdslb.com/a.jpg"></div>
    <table><tr><td>测试番剧</td></tr></table></div></div>"""

    def make_client(**kwargs):
        options.append(kwargs)
        direct = kwargs.get("trust_env") is False

        async def respond(request):
            requests.append((str(request.url), direct))
            if not direct:
                try:
                    raise ssl.SSLCertVerificationError(1, "certificate has expired")
                except ssl.SSLCertVerificationError as exc:
                    raise httpx.ConnectError("TLS failed", request=request) from exc
            if request.url.host == "yuc.wiki":
                return httpx.Response(200, text=html)
            return httpx.Response(200, content=b"cover", headers={"content-type": "image/jpeg"})

        return original_client(transport=httpx.MockTransport(respond), **kwargs)

    monkeypatch.setattr(service.httpx, "AsyncClient", make_client)
    result = await service.ensure_season("202601")
    assert result["items"][0]["title"] == "测试番剧"
    assert (tmp_path / "202601" / "season.json").exists()
    assert (tmp_path / "202601" / "1.img").read_bytes() == b"cover"
    assert requests == [
        ("https://yuc.wiki/202601/", False),
        ("https://yuc.wiki/202601/", True),
        ("https://i0.hdslb.com/a.jpg", False),
        ("https://i0.hdslb.com/a.jpg", True),
    ]
    assert all(option.get("verify", True) is True for option in options)
    assert all(option["follow_redirects"] is True for option in options)
    assert "202601" not in service._failures
    assert recorded[-1][0] == "calendar.fetch.completed"


async def test_direct_certificate_failure_still_returns_503(monkeypatch, tmp_path, recorded):
    from fastapi import HTTPException

    monkeypatch.setattr(service.settings, "calendar_cache_path", str(tmp_path))
    monkeypatch.setattr(service, "_failures", {})
    calls = []

    async def fail(self, url, **kwargs):
        calls.append(url)
        try:
            raise ssl.SSLCertVerificationError(1, "certificate has expired")
        except ssl.SSLCertVerificationError as exc:
            raise httpx.ConnectError("TLS failed") from exc

    monkeypatch.setattr(httpx.AsyncClient, "get", fail)
    with pytest.raises(HTTPException) as error:
        await service.read_calendar("202601", session=None)
    assert error.value.status_code == 503
    assert "证书" in error.value.detail
    assert len(calls) == 2
    assert not (tmp_path / "202601" / "season.json").exists()
    assert recorded[-1][0] == "calendar.fetch.failed"


@pytest.mark.parametrize("season", ["202602", "202613", "../202601", "209901"])
def test_invalid_season(season):
    with pytest.raises(ValueError):
        service.validate_season(season)


async def test_cover_failure_emits_warning(monkeypatch, tmp_path, recorded):
    monkeypatch.setattr(service.settings, "calendar_cache_path", str(tmp_path))

    async def fail(request):
        return httpx.Response(403)

    async with httpx.AsyncClient(transport=httpx.MockTransport(fail)) as client:
        await service.download_covers(
            client,
            "202601",
            [
                {"id": 1, "title": "测试番剧", "cover_source": "https://i0.hdslb.com/a.jpg"},
            ],
        )
    assert recorded[0][0] == "calendar.covers.partial"
    assert recorded[0][2]["count"] == 1
    assert "403" in recorded[0][2]["error"]


@pytest.mark.parametrize(
    "source",
    [
        "http://i0.hdslb.com/cover.jpg",
        "http://yuc.wiki/cover.jpg",
        "https://i.imgs.ovh/2026/cover.jpg",
    ],
)
async def test_other_covers_use_https_on_trusted_hosts(monkeypatch, tmp_path, recorded, source):
    monkeypatch.setattr(service.settings, "calendar_cache_path", str(tmp_path))
    (tmp_path / "202601").mkdir()
    requests = []

    async def respond(request):
        requests.append(str(request.url))
        return httpx.Response(200, content=b"cover", headers={"content-type": "image/jpeg"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        await service.download_covers(
            client,
            "202601",
            [
                {"id": 1, "title": "网络番剧", "cover_source": source},
            ],
        )
    assert requests == [source.replace("http://", "https://", 1)]
    assert (tmp_path / "202601" / "1.img").read_bytes() == b"cover"
    assert not recorded


@pytest.mark.parametrize(
    "source",
    [
        "http://localhost/cover.jpg",
        "https://hdslb.com.example.org/cover.jpg",
        "file:///cover.jpg",
    ],
)
async def test_untrusted_cover_urls_are_not_fetched(monkeypatch, tmp_path, recorded, source):
    monkeypatch.setattr(service.settings, "calendar_cache_path", str(tmp_path))

    async def no_network(request):
        pytest.fail("untrusted cover must not access network")

    async with httpx.AsyncClient(transport=httpx.MockTransport(no_network)) as client:
        await service.download_covers(
            client,
            "202601",
            [
                {"id": 1, "title": "网络番剧", "cover_source": source},
            ],
        )
    assert recorded[0][0] == "calendar.covers.partial"


async def test_event_persisted_and_broadcast(monkeypatch, tmp_path):
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.database import Base
    from app.events import broker, event_log_fields
    from app.models import DomainEvent

    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'events.db'}")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(service, "SessionFactory", factory)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with broker.subscribe() as queue:
            await service.record_calendar_event(
                "calendar.fetch.failed",
                "202601",
                error="ConnectError: token=private",
            )
            live = queue.get_nowait()
        async with factory() as session:
            stored = await session.scalar(select(DomainEvent))
            assert stored.id == live.id
            assert "private" not in stored.payload
            assert "private" not in live.as_sse("log")
            level, scope, message = event_log_fields(stored.event_type, json.loads(stored.payload))
            assert (level, scope) == ("error", "calendar")
            assert "202601" in message
            assert "event: log" in live.as_sse("log")
    finally:
        await engine.dispose()
