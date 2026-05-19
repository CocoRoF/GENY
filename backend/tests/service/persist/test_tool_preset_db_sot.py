"""Phase 2A — ToolPresetStore Postgres-SOT + JSON-fallback behaviour.

Uses an in-memory stub of AppDatabaseManager because the real one
needs a running Postgres. The stub re-implements just enough of the
``execute_insert / execute_query / execute_query_one /
execute_update_delete`` surface to back the store's UPSERT + SELECT
+ DELETE queries.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pytest


# ── Stub DB ────────────────────────────────────────────────────────


class _StubDBManager:
    """Minimal in-memory backend for the tool_presets table."""

    def __init__(self) -> None:
        self._rows: Dict[str, Dict[str, Any]] = {}
        self.healthy: bool = True
        self.calls: List[Tuple[str, tuple]] = []

    def _is_pool_healthy(self) -> bool:
        return self.healthy

    def execute_insert(self, query: str, params: tuple) -> int:
        self.calls.append((query, params))
        if "INSERT INTO tool_presets" in query:
            preset_id, name, is_template, template_name, payload = params
            self._rows[preset_id] = {
                "preset_id": preset_id,
                "name": name,
                "is_template": is_template,
                "template_name": template_name,
                "data": payload,
            }
            return 1
        raise AssertionError(f"Unexpected insert query: {query}")

    def execute_query(self, query: str, params: tuple = ()) -> List[Dict[str, Any]]:
        self.calls.append((query, params))
        if "SELECT data FROM tool_presets" in query and "WHERE" not in query:
            return [{"data": row["data"]} for row in self._rows.values()]
        raise AssertionError(f"Unexpected query: {query}")

    def execute_query_one(self, query: str, params: tuple) -> Optional[Dict[str, Any]]:
        self.calls.append((query, params))
        if "SELECT data FROM tool_presets WHERE preset_id" in query:
            (preset_id,) = params
            row = self._rows.get(preset_id)
            return {"data": row["data"]} if row else None
        if "SELECT 1 FROM tool_presets WHERE preset_id" in query:
            (preset_id,) = params
            return {"?column?": 1} if preset_id in self._rows else None
        raise AssertionError(f"Unexpected query_one: {query}")

    def execute_update_delete(self, query: str, params: tuple) -> int:
        self.calls.append((query, params))
        if "DELETE FROM tool_presets WHERE preset_id" in query:
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
def isolated_store(monkeypatch, tmp_path):
    target = tmp_path / "tool_presets"
    monkeypatch.setenv("GENY_TOOL_PRESETS_DIR", str(target))
    from service.tool_preset.store import ToolPresetStore

    yield ToolPresetStore()


@pytest.fixture
def stub_db():
    return _StubAppDB()


# ── Tests ──────────────────────────────────────────────────────────


def _make_preset(name: str = "p1"):
    from service.tool_preset.models import ToolPresetDefinition

    return ToolPresetDefinition(name=name, custom_tools=["echo"], mcp_servers=[])


def test_save_writes_to_both_backends(isolated_store, stub_db):
    isolated_store.set_database(stub_db)
    preset = _make_preset("alpha")

    isolated_store.save(preset)

    # File side mirrors
    file_path = isolated_store._path_for(preset.id)
    assert file_path.exists()
    assert json.loads(file_path.read_text())["name"] == "alpha"
    # DB side has the row
    assert preset.id in stub_db.db_manager._rows


def test_save_falls_back_to_file_when_db_unhealthy(isolated_store, stub_db):
    isolated_store.set_database(stub_db)
    stub_db.db_manager.healthy = False
    preset = _make_preset("beta")

    isolated_store.save(preset)

    assert isolated_store._path_for(preset.id).exists()
    assert preset.id not in stub_db.db_manager._rows


def test_load_prefers_db_over_file(isolated_store, stub_db):
    isolated_store.set_database(stub_db)
    preset = _make_preset("gamma")
    isolated_store.save(preset)

    # Mutate the DB row so we can detect which backend served the load
    db_row = stub_db.db_manager._rows[preset.id]
    db_row["data"] = re.sub(r'"name":\s*"gamma"', '"name":"DB-VERSION"', db_row["data"])

    loaded = isolated_store.load(preset.id)
    assert loaded is not None
    assert loaded.name == "DB-VERSION"


def test_load_falls_back_to_file_when_db_empty(isolated_store, stub_db):
    isolated_store.set_database(stub_db)
    preset = _make_preset("delta")
    isolated_store._save_to_file(preset)  # File only

    loaded = isolated_store.load(preset.id)
    assert loaded is not None
    assert loaded.name == "delta"


def test_delete_removes_both_sides(isolated_store, stub_db):
    isolated_store.set_database(stub_db)
    preset = _make_preset("epsilon")
    isolated_store.save(preset)

    removed = isolated_store.delete(preset.id)
    assert removed is True
    assert preset.id not in stub_db.db_manager._rows
    assert not isolated_store._path_for(preset.id).exists()


def test_list_merges_db_and_file_only(isolated_store, stub_db):
    isolated_store.set_database(stub_db)

    a = _make_preset("alpha")
    b = _make_preset("beta")
    isolated_store.save(a)             # DB + file
    isolated_store._save_to_file(b)    # file only (e.g. DB outage)

    listed = {p.id: p.name for p in isolated_store.list_all()}
    assert listed[a.id] == "alpha"
    assert listed[b.id] == "beta"


def test_reconcile_pushes_file_only_to_db(isolated_store, stub_db):
    # Pre-populate a file-only preset before DB is attached
    preset = _make_preset("zeta")
    isolated_store._save_to_file(preset)
    assert preset.id not in stub_db.db_manager._rows

    isolated_store.set_database(stub_db)  # triggers reconcile

    assert preset.id in stub_db.db_manager._rows


def test_reconcile_mirrors_db_row_to_file(isolated_store, stub_db):
    # Pre-populate DB before attaching
    preset = _make_preset("eta")
    stub_db.db_manager._rows[preset.id] = {
        "preset_id": preset.id,
        "name": preset.name,
        "is_template": False,
        "template_name": "",
        "data": preset.model_dump_json(),
    }

    isolated_store.set_database(stub_db)

    path = isolated_store._path_for(preset.id)
    assert path.exists()
    assert json.loads(path.read_text())["name"] == "eta"


def test_no_db_attached_is_file_only(isolated_store):
    """Pre-Phase-2 behaviour: without set_database, store is JSON-only."""
    preset = _make_preset("theta")
    isolated_store.save(preset)

    assert isolated_store._path_for(preset.id).exists()
    # Loading still works without a DB
    loaded = isolated_store.load(preset.id)
    assert loaded is not None
    assert loaded.name == "theta"
