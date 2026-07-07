"""Knowledge connectors P2 — continuous collection into the user vault.

Persistence + cron due-logic + run_source bookkeeping run against real
files on a tmp vault; the DB fetcher runs against a real sqlite database
(SQLAlchemy). Network fetchers are exercised through run_source with a
stubbed fetcher — the contract is stable doc_key → update-not-duplicate.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List

import pytest

import service.knowledge.connectors as conn
import service.knowledge.service as ks


@pytest.fixture()
def vault(tmp_path, monkeypatch):
    import service.memory.user_opsidian as uo

    monkeypatch.setattr(
        uo.UserOpsidianManager, "_default_path",
        staticmethod(lambda: str(tmp_path)),
    )
    uo._user_managers.clear()
    yield tmp_path
    uo._user_managers.clear()


class _FakeStore:
    def __init__(self):
        self.indexed: Dict[str, List[Any]] = {}

    async def index_document(self, ref, chunks):
        self.indexed[ref.filename] = list(chunks)
        return len(chunks)

    async def search(self, query, top_k=8):
        return []

    async def remove(self, ref):
        return True


@pytest.fixture()
def svc(vault, monkeypatch):
    service = ks.KnowledgeService("tester")
    fake = _FakeStore()
    monkeypatch.setattr(service, "_vector", lambda: fake)
    monkeypatch.setattr(conn, "get_knowledge_service", lambda username: service)
    return service, fake


def test_source_crud_roundtrip(vault):
    src = conn.upsert_source("tester", {
        "name": "docs api", "type": "api",
        "config": {"url": "https://example.com/api"},
    })
    assert src["id"] and src["enabled"] and src["schedule"]

    path = conn._sources_path("tester")
    assert path.exists()
    assert (path.stat().st_mode & 0o777) == 0o600  # configs carry secrets

    # Update keeps identity; unknown fields for bookkeeping survive edits.
    conn.upsert_source("tester", {**src, "name": "renamed"})
    rows = conn.load_sources("tester")
    assert [r["name"] for r in rows] == ["renamed"]

    assert conn.delete_source("tester", src["id"]) is True
    assert conn.load_sources("tester") == []
    assert conn.delete_source("tester", "missing") is False


def test_due_logic():
    now = datetime(2026, 7, 7, 12, 30, tzinfo=timezone.utc).timestamp()
    base = {"schedule": "0 * * * *", "enabled": True}

    assert conn._due({**base}, now) is True  # never ran
    assert conn._due({**base, "enabled": False}, now) is False
    recent = datetime(2026, 7, 7, 12, 10, tzinfo=timezone.utc)
    assert conn._due({**base, "last_run_at": recent.isoformat()}, now) is False
    old = recent - timedelta(hours=2)
    assert conn._due({**base, "last_run_at": old.isoformat()}, now) is True
    bad = {**base, "schedule": "not-cron", "last_run_at": old.isoformat()}
    assert conn._due(bad, now) is False  # bad cron must not loop-fire


@pytest.mark.asyncio
async def test_run_source_stable_doc_key_updates_not_duplicates(svc, monkeypatch):
    service, fake = svc
    payload = {"text": "첫 수집 본문입니다. " * 60}

    async def fetch(source):
        return [{
            "title": "api — https://example.com/api",
            "text": payload["text"], "ext": "txt",
            "locator": "https://example.com/api",
        }]

    monkeypatch.setitem(conn._FETCHERS, "api", fetch)
    src = conn.upsert_source("tester", {
        "name": "docs", "type": "api", "config": {"url": "x"},
    })

    report = await conn.run_source("tester", src)
    assert report["ok"] and report["ingested"] == 1

    # Same content again → unchanged (content-sha no-op).
    report2 = await conn.run_source("tester", src)
    assert report2["ok"] and report2["unchanged"] == 1

    # Changed content → SAME card updated (stable doc_key), not a new one.
    payload["text"] = "갱신된 본문입니다. " * 60
    report3 = await conn.run_source("tester", src)
    assert report3["ok"] and report3["ingested"] == 1
    docs = await service.list_documents()
    assert len(docs) == 1

    # Bookkeeping persisted on the stored source.
    stored = conn.load_sources("tester")[0]
    assert stored["last_run_at"] and stored["last_result"]["ok"] is True


@pytest.mark.asyncio
async def test_run_source_records_error(svc):
    src = conn.upsert_source("tester", {
        "name": "broken", "type": "api", "config": {},  # missing url
    })
    report = await conn.run_source("tester", src)
    assert report["ok"] is False
    assert "url" in report["error"]
    stored = conn.load_sources("tester")[0]
    assert stored["last_result"]["ok"] is False


@pytest.mark.asyncio
async def test_fetch_db_renders_rows_as_records(tmp_path):
    db_path = tmp_path / "data.sqlite"
    from sqlalchemy import create_engine, text

    engine = create_engine(f"sqlite:///{db_path}")
    with engine.begin() as tx:
        tx.execute(text("create table items (name text, price int)"))
        tx.execute(text("insert into items values ('alpha', 100), ('beta', 200)"))
    engine.dispose()

    docs = await conn._fetch_db({
        "name": "product db", "type": "db",
        "config": {
            "dsn": f"sqlite:///{db_path}",
            "query": "select * from items",
            "key_column": "name",
        },
    })
    assert len(docs) == 1
    body = docs[0]["text"]
    assert "## alpha" in body and "- price: 200" in body
    assert docs[0]["ext"] == "md"
