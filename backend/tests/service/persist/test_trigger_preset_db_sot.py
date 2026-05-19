"""Phase 2C — TriggerPresetService Postgres-SOT + JSON-fallback behaviour.

Stub-DB pattern matches Phase 2A/2B tests.
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
        if "INSERT INTO trigger_presets" in query:
            preset_id, name, payload = params
            self._rows[preset_id] = {
                "preset_id": preset_id,
                "name": name,
                "data": payload,
            }
            return 1
        raise AssertionError(f"Unexpected insert query: {query}")

    def execute_query(self, query: str, params: tuple = ()) -> List[Dict[str, Any]]:
        self.calls.append((query, params))
        if "SELECT data FROM trigger_presets" in query and "WHERE" not in query:
            return [{"data": r["data"]} for r in self._rows.values()]
        raise AssertionError(f"Unexpected query: {query}")

    def execute_query_one(self, query: str, params: tuple) -> Optional[Dict[str, Any]]:
        self.calls.append((query, params))
        if "SELECT data FROM trigger_presets WHERE preset_id" in query:
            (preset_id,) = params
            row = self._rows.get(preset_id)
            return {"data": row["data"]} if row else None
        raise AssertionError(f"Unexpected query_one: {query}")

    def execute_update_delete(self, query: str, params: tuple) -> int:
        self.calls.append((query, params))
        if "DELETE FROM trigger_presets WHERE preset_id" in query:
            (preset_id,) = params
            if preset_id in self._rows:
                del self._rows[preset_id]
                return 1
            return 0
        raise AssertionError(f"Unexpected delete: {query}")


class _StubAppDB:
    def __init__(self) -> None:
        self.db_manager = _StubDBManager()


# ── Fixtures ───────────────────────────────────────────────────────


@pytest.fixture
def isolated_service(monkeypatch, tmp_path):
    storage = tmp_path / "trigger_presets"
    monkeypatch.setenv("TRIGGER_PRESET_STORAGE_PATH", str(storage))
    from service.trigger_preset.service import TriggerPresetService

    yield TriggerPresetService()


@pytest.fixture
def stub_db():
    return _StubAppDB()


# ── Tests ──────────────────────────────────────────────────────────


def test_create_writes_to_both_backends(isolated_service, stub_db):
    isolated_service.set_database(stub_db)
    preset_id = isolated_service.create(name="alpha", description="t1")

    # DB row present
    assert preset_id in stub_db.db_manager._rows
    # File mirror present
    assert isolated_service._path(preset_id).exists()


def test_get_prefers_db(isolated_service, stub_db):
    isolated_service.set_database(stub_db)
    preset_id = isolated_service.create(name="beta")

    # Mutate DB row to verify it's the served read. The store dumps
    # JSON via ``json.dumps(...)`` which inserts a space after the
    # colon, so match either compact or pretty-printed form.
    row = stub_db.db_manager._rows[preset_id]
    payload = json.loads(row["data"])
    payload["name"] = "DB-VERSION"
    row["data"] = json.dumps(payload)

    record = isolated_service.get(preset_id)
    assert record is not None
    assert record.name == "DB-VERSION"


def test_get_falls_back_to_file_when_db_empty(isolated_service, stub_db):
    isolated_service.set_database(stub_db)
    preset_id = isolated_service.create(name="gamma")
    # Wipe the DB row, leaving only the file mirror
    del stub_db.db_manager._rows[preset_id]

    record = isolated_service.get(preset_id)
    assert record is not None
    assert record.name == "gamma"


def test_delete_clears_both_sides(isolated_service, stub_db):
    isolated_service.set_database(stub_db)
    preset_id = isolated_service.create(name="delta")

    assert isolated_service.delete(preset_id) is True
    assert preset_id not in stub_db.db_manager._rows
    assert not isolated_service._path(preset_id).exists()


def test_list_all_merges_db_and_file_only(isolated_service, stub_db):
    isolated_service.set_database(stub_db)
    a_id = isolated_service.create(name="alpha")

    # Drop "alpha" from the DB to simulate a file-only orphan
    del stub_db.db_manager._rows[a_id]

    # Create a second preset that lives in both backends
    b_id = isolated_service.create(name="beta")

    summaries = {s["id"]: s["name"] for s in isolated_service.list_all()}
    assert summaries[a_id] == "alpha"  # file-only orphan surfaced
    assert summaries[b_id] == "beta"   # DB row served


def test_reconcile_pushes_file_only_to_db(isolated_service, stub_db):
    # Create file-only first (no DB attached)
    preset_id = isolated_service.create(name="zeta")
    assert preset_id not in stub_db.db_manager._rows

    isolated_service.set_database(stub_db)  # triggers reconcile
    assert preset_id in stub_db.db_manager._rows


def test_reconcile_mirrors_db_row_to_file(isolated_service, stub_db):
    from service.trigger_preset.schemas import TriggerPresetRecord
    from service.trigger_preset.defaults import default_manifest

    record = TriggerPresetRecord(
        id="abcdef123456",
        name="eta",
        description="",
        tags=[],
        created_at="2026-05-19T00:00:00Z",
        updated_at="2026-05-19T00:00:00Z",
        manifest=default_manifest(),
    )
    stub_db.db_manager._rows[record.id] = {
        "preset_id": record.id,
        "name": record.name,
        "data": json.dumps(record.model_dump(mode="json")),
    }

    isolated_service.set_database(stub_db)

    path = isolated_service._path(record.id)
    assert path.exists()
    assert json.loads(path.read_text())["name"] == "eta"


def test_create_falls_back_to_file_when_db_unhealthy(isolated_service, stub_db):
    isolated_service.set_database(stub_db)
    stub_db.db_manager.healthy = False

    preset_id = isolated_service.create(name="theta")

    assert isolated_service._path(preset_id).exists()
    assert preset_id not in stub_db.db_manager._rows


def test_no_db_attached_is_file_only(isolated_service):
    """Pre-Phase-2C behaviour: without set_database, JSON files only."""
    preset_id = isolated_service.create(name="iota")
    assert isolated_service._path(preset_id).exists()
    assert isolated_service.get(preset_id) is not None


def test_update_metadata_persists_to_db(isolated_service, stub_db):
    isolated_service.set_database(stub_db)
    preset_id = isolated_service.create(name="kappa")

    isolated_service.update_metadata(preset_id, name="kappa-v2")

    record = isolated_service.get(preset_id)
    assert record is not None
    assert record.name == "kappa-v2"
    # And the DB row was updated by the UPSERT
    assert stub_db.db_manager._rows[preset_id]["name"] == "kappa-v2"


def test_duplicate_writes_new_row_to_db(isolated_service, stub_db):
    isolated_service.set_database(stub_db)
    src_id = isolated_service.create(name="lambda")

    dup_id = isolated_service.duplicate(src_id, "lambda-clone")

    assert dup_id != src_id
    assert dup_id in stub_db.db_manager._rows
    assert stub_db.db_manager._rows[dup_id]["name"] == "lambda-clone"
