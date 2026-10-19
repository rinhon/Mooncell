"""备份并迁移本机 Mikan 订阅域名，保留条目及下载任务的身份。"""

import argparse
import hashlib
import json
import sqlite3
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

OLD_HOST = "mikan.tangbai.cc"
NEW_HOST = "mikanani.me"


def replace_domain(value: str | None) -> str | None:
    if not value:
        return value
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or parsed.hostname != OLD_HOST:
        return value
    return urlunsplit(parsed._replace(scheme="https", netloc=NEW_HOST))


def migrate(database: Path, backup_directory: Path) -> dict:
    database = database.resolve(strict=True)
    with closing(sqlite3.connect(database, timeout=30)) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("BEGIN IMMEDIATE")
        try:
            sources = list(connection.execute("SELECT id, url FROM feed_sources"))
            source_changes = [(replace_domain(row["url"]), row["id"]) for row in sources
                              if replace_domain(row["url"]) != row["url"]]
            source_urls = [replace_domain(row["url"]) for row in sources]
            if len(set(source_urls)) != len(source_urls):
                raise ValueError("迁移后订阅地址重复，已取消操作")

            items = list(connection.execute(
                "SELECT id, source_id, guid, title, detail_url, download_url, fingerprint "
                "FROM feed_items"
            ))
            planned_items = []
            groups = {}
            for row in items:
                guid, detail_url, download_url = (
                    replace_domain(row[column]) for column in ("guid", "detail_url", "download_url")
                )
                changed = (guid, detail_url, download_url) != (
                    row["guid"], row["detail_url"], row["download_url"]
                )
                fingerprint = row["fingerprint"]
                if changed:
                    identity = "|".join([
                        str(row["source_id"]), str(guid or ""),
                        str(download_url or detail_url or ""), row["title"],
                    ])
                    fingerprint = hashlib.sha256(identity.encode("utf-8")).hexdigest()
                planned = {"id": row["id"], "source_id": row["source_id"], "changed": changed,
                           "guid": guid, "detail_url": detail_url, "download_url": download_url,
                           "fingerprint": fingerprint, "original_fingerprint": row["fingerprint"]}
                planned_items.append(planned)
                key = row["source_id"], fingerprint
                groups.setdefault(key, []).append(planned)

            duplicates_preserved = 0
            for group in groups.values():
                if len(group) < 2:
                    continue
                # 已有新域名记录优先保留规范指纹；旧重复记录保留原指纹和任务关联。
                canonical = min(group, key=lambda item: (
                    item["original_fingerprint"] != item["fingerprint"], item["id"],
                ))
                for item in group:
                    if item is not canonical:
                        item["fingerprint"] = item["original_fingerprint"]
                        duplicates_preserved += 1

            item_changes = []
            final_fingerprints = set()
            for item in planned_items:
                key = item["source_id"], item["fingerprint"]
                if key in final_fingerprints:
                    raise ValueError("迁移后发布条目重复，已取消操作")
                final_fingerprints.add(key)
                if item["changed"]:
                    item_changes.append(tuple(item[column] for column in (
                        "guid", "detail_url", "download_url", "fingerprint", "id",
                    )))

            if not source_changes and not item_changes:
                connection.rollback()
                return {"subscriptions": 0, "items": 0, "duplicates_preserved": 0, "backup": None}

            backup_directory.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
            backup = backup_directory / f"mooncell-before-mikan-{stamp}-{uuid4().hex[:8]}.db"
            # 主连接持有写锁；另一只读连接备份已提交快照，避免备份遗漏 WAL。
            uri = database.as_uri() + "?mode=ro"
            with closing(sqlite3.connect(uri, uri=True)) as original:
                with closing(sqlite3.connect(backup)) as destination:
                    original.backup(destination)

            now = datetime.now(UTC).replace(tzinfo=None).isoformat(sep=" ")
            connection.executemany(
                "UPDATE feed_sources SET url=?, etag=NULL, last_modified=NULL, "
                "connection_status='unknown', last_error=NULL, updated_at=? WHERE id=?",
                [(url, now, source_id) for url, source_id in source_changes],
            )
            # 先用临时指纹腾出唯一键，避免逐条更新时发生短暂键冲突。
            for *_values, item_id in item_changes:
                temporary = hashlib.sha256(f"{uuid4().hex}:{item_id}".encode()).hexdigest()
                connection.execute("UPDATE feed_items SET fingerprint=? WHERE id=?",
                                   (temporary, item_id))
            connection.executemany(
                "UPDATE feed_items SET guid=?, detail_url=?, download_url=?, fingerprint=? "
                "WHERE id=?", item_changes,
            )
            if connection.execute("PRAGMA foreign_key_check").fetchone():
                raise ValueError("外键校验失败，迁移已回滚")
            connection.commit()
            return {"subscriptions": len(source_changes), "items": len(item_changes),
                    "duplicates_preserved": duplicates_preserved, "backup": str(backup.resolve())}
        except BaseException:
            connection.rollback()
            raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--backup-directory", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(migrate(args.database, args.backup_directory), ensure_ascii=True))
