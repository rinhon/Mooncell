import json
from datetime import UTC, datetime

import pytest

from app.models import FeedItem


@pytest.mark.asyncio
async def test_releases_source_sort_pagination_and_bad_parse(show_client):
    client, sessions, _ = show_client
    date = datetime(2026, 10, 17, tzinfo=UTC)
    parsed = {
        "raw_title": "特别篇 0.5-2v2",
        "confidence": 0.9,
        "season": 0,
        "episode_start": 0.5,
        "episode_end": 2,
        "revision": 2,
        "release_kind": "range",
    }
    async with sessions() as session:
        for index, (source_id, published, value) in enumerate(
            [
                (1, date, json.dumps(parsed)),
                (1, date, "broken"),
                (1, date, "{}"),
                (1, None, json.dumps(parsed)),
                (2, date, json.dumps(parsed)),
            ]
        ):
            session.add(
                FeedItem(
                    source_id=source_id,
                    title=str(index),
                    fingerprint=str(index),
                    published_at=published,
                    discovered_at=date,
                    parse_data=value,
                )
            )
        await session.commit()
    first = (await client.get("/api/v1/shows/1/releases?page_size=2")).json()
    assert first["total"] == 4
    assert [row["title"] for row in first["items"]] == ["2", "1"]
    assert all(row["parsed"] is None for row in first["items"])
    second = (await client.get("/api/v1/shows/1/releases?page=2&page_size=2")).json()
    assert [row["title"] for row in second["items"]] == ["0", "3"]
    assert second["items"][0]["parsed"]["episode_start"] == 0.5
    assert second["items"][0]["parsed"]["season"] == 0
    assert second["items"][0]["parsed"]["revision"] == 2
    assert (await client.get("/api/v1/shows/1/releases?page=8")).json()["items"] == []
    assert (await client.get("/api/v1/shows/999/releases")).status_code == 404
    for query in ["page=0", "page_size=0", "page_size=101", "page=x"]:
        assert (await client.get(f"/api/v1/shows/1/releases?{query}")).status_code == 422


@pytest.mark.asyncio
async def test_releases_empty(show_client):
    client, _, _ = show_client
    assert (await client.get("/api/v1/shows/1/releases")).json() == {
        "items": [],
        "total": 0,
        "page": 1,
        "page_size": 20,
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "fields",
    [
        {"media_type": "movie"},
        {"media_type": "episode", "episode_start": 1},
        {"media_type": "special", "season": 0, "episode_start": 0.5},
        {"release_kind": "range", "episode_start": 1, "episode_end": 12},
        {"release_kind": "batch", "episode_start": 1, "episode_end": 12},
        {"release_kind": "collection", "revision": 3},
    ],
)
async def test_releases_preserve_media_and_episode_semantics(show_client, fields):
    client, sessions, _ = show_client
    value = {"raw_title": "原始发布名", "confidence": 0.7, **fields}
    async with sessions() as session:
        session.add(
            FeedItem(
                source_id=1, title="原始发布名", fingerprint="only", parse_data=json.dumps(value)
            )
        )
        await session.commit()
    result = (await client.get("/api/v1/shows/1/releases")).json()
    assert result["total"] == 1 and len(result["items"]) == 1
    assert result["items"][0]["title"] == "原始发布名"
    for key, expected in fields.items():
        assert result["items"][0]["parsed"][key] == expected
    assert (await client.get("/api/v1/shows/1")).json()["discovered_items"] == 1
