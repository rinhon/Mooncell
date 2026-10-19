import hashlib
import sqlite3
from contextlib import closing

import pytest
from migrate_mikan_domain import migrate, replace_domain


@pytest.mark.parametrize(("value", "expected"), [
    ("https://mikan.tangbai.cc/RSS/Bangumi?bangumiId=7&subgroupid=2",
     "https://mikanani.me/RSS/Bangumi?bangumiId=7&subgroupid=2"),
    ("http://mikan.tangbai.cc/Home/Episode/abc#details",
     "https://mikanani.me/Home/Episode/abc#details"),
    ("https://mikan.tangbai.cc.example.test/RSS", "https://mikan.tangbai.cc.example.test/RSS"),
    ("magnet:?xt=urn:btih:abc", "magnet:?xt=urn:btih:abc"),
    ("A title mentioning mikan.tangbai.cc", "A title mentioning mikan.tangbai.cc"),
    (None, None),
])
def test_only_target_host_is_replaced(value, expected):
    assert replace_domain(value) == expected


def create_database(path):
    with closing(sqlite3.connect(path)) as connection:
        connection.executescript("""
            CREATE TABLE feed_sources (
                id INTEGER PRIMARY KEY, url TEXT UNIQUE, etag TEXT, last_modified TEXT,
                connection_status TEXT, last_error TEXT, updated_at TEXT
            );
            CREATE TABLE feed_items (
                id INTEGER PRIMARY KEY, source_id INTEGER REFERENCES feed_sources(id),
                guid TEXT, title TEXT, detail_url TEXT, download_url TEXT, fingerprint TEXT,
                UNIQUE(source_id, fingerprint)
            );
            CREATE TABLE download_jobs (
                id INTEGER PRIMARY KEY, item_id INTEGER REFERENCES feed_items(id)
            );
            INSERT INTO feed_sources VALUES (
                1, 'https://mikan.tangbai.cc/RSS/Bangumi?bangumiId=7', 'old-etag',
                'old-date', 'error', 'old-error', 'old-date'
            );
            INSERT INTO feed_items VALUES (
                2, 1, 'episode-1', 'Example 01', 'https://mikan.tangbai.cc/Home/Episode/abc',
                'https://mikan.tangbai.cc/Download/abc.torrent', 'old-fingerprint'
            );
            INSERT INTO download_jobs VALUES (3, 2);
        """)
        connection.commit()


def test_migration_backs_up_and_preserves_jobs_and_deduplication(tmp_path):
    database = tmp_path / "mooncell.db"
    create_database(database)
    result = migrate(database, tmp_path / "backups")
    assert (result["subscriptions"], result["items"]) == (1, 1)
    with closing(sqlite3.connect(database)) as connection:
        source = connection.execute("SELECT * FROM feed_sources").fetchone()
        assert source[1] == "https://mikanani.me/RSS/Bangumi?bangumiId=7"
        assert source[2:6] == (None, None, "unknown", None)
        item = connection.execute("SELECT * FROM feed_items").fetchone()
        identity = "1|episode-1|https://mikanani.me/Download/abc.torrent|Example 01"
        assert item[-1] == hashlib.sha256(identity.encode()).hexdigest()
        assert connection.execute("SELECT * FROM download_jobs").fetchone() == (3, 2)
    with closing(sqlite3.connect(result["backup"])) as backup:
        saved_url = backup.execute("SELECT url FROM feed_sources").fetchone()[0]
        assert "mikan.tangbai.cc" in saved_url
        saved_fingerprint = backup.execute("SELECT fingerprint FROM feed_items").fetchone()[0]
        assert saved_fingerprint == "old-fingerprint"
    assert migrate(database, tmp_path / "backups") == {
        "subscriptions": 0, "items": 0, "duplicates_preserved": 0, "backup": None,
    }


def test_existing_new_domain_duplicate_keeps_both_records_and_jobs(tmp_path):
    database = tmp_path / "mooncell.db"
    create_database(database)
    identity = "1|episode-1|https://mikanani.me/Download/abc.torrent|Example 01"
    fingerprint = hashlib.sha256(identity.encode()).hexdigest()
    with closing(sqlite3.connect(database)) as connection:
        connection.execute("INSERT INTO feed_items VALUES (?, ?, ?, ?, ?, ?, ?)", (
            4, 1, "episode-1", "Example 01", "https://mikanani.me/Home/Episode/abc",
            "https://mikanani.me/Download/abc.torrent", fingerprint,
        ))
        connection.execute("INSERT INTO download_jobs VALUES (5, 4)")
        connection.commit()
    assert migrate(database, tmp_path / "backups")["duplicates_preserved"] == 1
    with closing(sqlite3.connect(database)) as connection:
        jobs = connection.execute("SELECT id, item_id FROM download_jobs ORDER BY id").fetchall()
        assert jobs == [(3, 2), (5, 4)]
        assert connection.execute("SELECT COUNT(*) FROM feed_items").fetchone()[0] == 2
        assert connection.execute("SELECT COUNT(*) FROM feed_items WHERE fingerprint=?",
                                  (fingerprint,)).fetchone()[0] == 1
        assert all("mikanani.me" in row[0] for row in connection.execute(
            "SELECT download_url FROM feed_items"))


def test_duplicate_subscription_aborts_without_changing_database(tmp_path):
    database = tmp_path / "mooncell.db"
    create_database(database)
    with closing(sqlite3.connect(database)) as connection:
        connection.execute("INSERT INTO feed_sources (id, url) VALUES (?, ?)", (
            2, "https://mikanani.me/RSS/Bangumi?bangumiId=7",
        ))
        connection.commit()
    with pytest.raises(ValueError, match="订阅地址重复"):
        migrate(database, tmp_path / "backups")
    with closing(sqlite3.connect(database)) as connection:
        assert "mikan.tangbai.cc" in connection.execute(
            "SELECT url FROM feed_sources WHERE id=1").fetchone()[0]
