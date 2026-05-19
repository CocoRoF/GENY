"""Phase 2B — EnvironmentService Postgres-SOT + JSON-fallback behaviour.

Mirrors test_tool_preset_db_sot.py: in-memory stub of
AppDatabaseManager so the suite runs without Postgres.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Tuple

import pytest


# ── Stub DB ────────────────────────────────────────────────────────


class _StubDBManager:
    def __init__(self) -> None:
        self._rows: Dict[str, Dict[str, Any]] = {}
        self.healthy: bool = True
        self.calls: List[Tuple[str, tuple]] = []

    def _is_pool_healthy(self) -> bool:
        return self.healthy

    def execute_insert(self, query: str, params: tuple) -> int:
        self.calls.append((query, params))
        if "INSERT INTO environments" in query:
            env_id, name, is_template, payload = params
            self._rows[env_id] = {
                "env_id": env_id,
                "name": name,
                "is_template": is_template,
                "data": payload,
            }
            return 1
        raise AssertionError(f"Unexpected insert query: {query}")

    def execute_query(self, query: str, params: tuple = ()) -> List[Dict[str, Any]]:
        self.calls.append((query, params))
        if "SELECT data FROM environments" in query and "WHERE" not in query:
            return [{"data": r["data"]} for r in self._rows.values()]
        raise AssertionError(f"Unexpected query: {query}")

    def execute_query_one(self, query: str, params: tuple) -> Optional[Dict[str, Any]]:
        self.calls.append((query, params))
        if "SELECT data FROM environments WHERE env_id" in query:
            (env_id,) = params
            row = self._rows.get(env_id)
            return {"data": row["data"]} if row else None
        raise AssertionError(f"Unexpected query_one: {query}")

    def execute_update_delete(self, query: str, params: tuple) -> int:
        self.calls.append((query, params))
        if "DELETE FROM environments WHERE env_id" in query:
            (env_id,) = params
            if env_id in self._rows:
                del self._rows[env_id]
                return 1
            return 0
        raise AssertionError(f"Unexpected delete: {query}")


class _StubAppDB:
    def __init__(self) -> None:
        self.db_manager = _StubDBManager()


# ── Fixtures ───────────────────────────────────────────────────────


@pytest.fixture
def isolated_service(monkeypatch, tmp_path):
    storage = tmp_path / "environments"
    monkeypatch.setenv("ENVIRONMENT_STORAGE_PATH", str(storage))
    from service.environment.service import EnvironmentService

    yield EnvironmentService()


@pytest.fixture
def stub_db():
    return _StubAppDB()


def _make_record(env_id: str = "abc123def456", name: str = "Env 1") -> Dict[str, Any]:
    """Build a minimal env record matching the on-disk JSON shape."""
    return {
        "id": env_id,
        "name": name,
        "description": "test",
        "tags": [],
        "manifest": {
            "metadata": {"id": env_id, "name": name, "description": "", "tags": []},
            "model": {"model": "claude-opus-4-7"},
            "pipeline": {"name": "test"},
            "stages": [],
            "tools": {},
        },
        "created_at": "2026-05-19T00:00:00Z",
        "updated_at": "2026-05-19T00:00:00Z",
    }


# ── Tests ──────────────────────────────────────────────────────────


def test_write_mirrors_to_db_and_file(isolated_service, stub_db):
    isolated_service.set_database(stub_db)
    rec = _make_record("aaa111")

    isolated_service._write_raw("aaa111", rec)

    # DB has it
    assert "aaa111" in stub_db.db_manager._rows
    # File has it
    assert isolated_service._path("aaa111").exists()


def test_read_prefers_db(isolated_service, stub_db):
    isolated_service.set_database(stub_db)
    rec = _make_record("bbb222", "from-file")
    isolated_service._write_raw("bbb222", rec)

    # Mutate DB row so we can detect which backend served the read
    db_row = stub_db.db_manager._rows["bbb222"]
    db_row["data"] = db_row["data"].replace('"name": "from-file"', '"name":"from-DB"')

    loaded = isolated_service._read_raw("bbb222")
    assert loaded is not None
    assert loaded["name"] == "from-DB"


def test_read_falls_back_to_file_when_db_empty(isolated_service, stub_db):
    isolated_service.set_database(stub_db)
    rec = _make_record("ccc333", "file-only")
    # Write only to disk
    isolated_service._path("ccc333").write_text(json.dumps(rec))

    loaded = isolated_service._read_raw("ccc333")
    assert loaded is not None
    assert loaded["name"] == "file-only"


def test_delete_clears_both_sides(isolated_service, stub_db):
    isolated_service.set_database(stub_db)
    rec = _make_record("ddd444")
    isolated_service._write_raw("ddd444", rec)

    assert isolated_service.delete("ddd444") is True
    assert "ddd444" not in stub_db.db_manager._rows
    assert not isolated_service._path("ddd444").exists()


def test_list_all_merges_db_and_file_only(isolated_service, stub_db):
    isolated_service.set_database(stub_db)

    a = _make_record("eee555", "from-db")
    isolated_service._write_raw("eee555", a)

    b = _make_record("fff666", "file-only")
    isolated_service._path("fff666").write_text(json.dumps(b))

    by_id = {summary["id"]: summary["name"] for summary in isolated_service.list_all()}
    assert by_id["eee555"] == "from-db"
    assert by_id["fff666"] == "file-only"


def test_reconcile_pushes_file_only_to_db(isolated_service, stub_db):
    rec = _make_record("ggg777", "file-only")
    isolated_service._path("ggg777").write_text(json.dumps(rec))
    assert "ggg777" not in stub_db.db_manager._rows

    isolated_service.set_database(stub_db)
    assert "ggg777" in stub_db.db_manager._rows


def test_reconcile_mirrors_db_row_to_file(isolated_service, stub_db):
    rec = _make_record("hhh888", "db-only")
    stub_db.db_manager._rows["hhh888"] = {
        "env_id": "hhh888",
        "name": "db-only",
        "is_template": False,
        "data": json.dumps(rec),
    }

    isolated_service.set_database(stub_db)

    path = isolated_service._path("hhh888")
    assert path.exists()
    on_disk = json.loads(path.read_text())
    assert on_disk["name"] == "db-only"


def test_write_falls_back_to_file_when_db_unhealthy(isolated_service, stub_db):
    isolated_service.set_database(stub_db)
    stub_db.db_manager.healthy = False
    rec = _make_record("iii999")

    isolated_service._write_raw("iii999", rec)

    assert isolated_service._path("iii999").exists()
    assert "iii999" not in stub_db.db_manager._rows


def test_no_db_attached_is_file_only(isolated_service):
    """Pre-Phase-2B behaviour: without set_database, JSON files only."""
    rec = _make_record("jjj000")
    isolated_service._write_raw("jjj000", rec)

    assert isolated_service._path("jjj000").exists()
    loaded = isolated_service._read_raw("jjj000")
    assert loaded is not None
    assert loaded["id"] == "jjj000"


def test_template_id_marks_is_template_in_db(isolated_service, stub_db):
    isolated_service.set_database(stub_db)
    rec = _make_record("template-worker", "Worker Template")

    isolated_service._write_raw("template-worker", rec)

    assert stub_db.db_manager._rows["template-worker"]["is_template"] is True
