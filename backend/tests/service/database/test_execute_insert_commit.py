"""Regression: execute_insert must commit even for INSERTs without RETURNING.

An ``INSERT ... ON CONFLICT DO UPDATE`` (no RETURNING) leaves ``cur.description``
None; calling ``fetchone()`` then raises ("didn't produce records") BEFORE the
commit, silently rolling the row back. That broke DB persistence for every
reconcile service (environments / tool presets / trigger presets), which all
UPSERT without RETURNING — they ran file-only. The fix only fetches when a
result set exists and always commits.
"""

from __future__ import annotations

import logging

from service.database.database_manager import DatabaseManager


class _FakeCursor:
    def __init__(self, description, fetch=None):
        self.description = description
        self._fetch = fetch
        self.fetchone_called = False
        self.executed = None

    def execute(self, query, params=None):
        self.executed = (query, params)

    def fetchone(self):
        self.fetchone_called = True
        return self._fetch

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class _FakeConn:
    def __init__(self, cur):
        self._cur = cur
        self.committed = False

    def cursor(self):
        return self._cur

    def commit(self):
        self.committed = True

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _mgr(cur):
    mgr = object.__new__(DatabaseManager)
    mgr.logger = logging.getLogger("test")
    mgr._execute_with_retry = lambda fn, name="op": fn()
    conn = _FakeConn(cur)
    mgr.get_connection = lambda *a, **k: conn
    return mgr, conn


def test_insert_without_returning_commits_and_skips_fetch():
    cur = _FakeCursor(description=None)          # no result set (no RETURNING)
    mgr, conn = _mgr(cur)
    out = mgr.execute_insert(
        "INSERT INTO trigger_presets (preset_id) VALUES (%s) "
        "ON CONFLICT (preset_id) DO UPDATE SET name = EXCLUDED.name",
        ("default",),
    )
    assert cur.fetchone_called is False   # the bug was calling this → raise → no commit
    assert conn.committed is True          # row actually persists now
    assert out is None


def test_insert_with_returning_still_fetches_id():
    cur = _FakeCursor(description=[("id",)], fetch=(42,))
    mgr, conn = _mgr(cur)
    out = mgr.execute_insert("INSERT INTO t (a) VALUES (1) RETURNING id", (1,))
    assert cur.fetchone_called is True
    assert conn.committed is True
    assert out == 42
