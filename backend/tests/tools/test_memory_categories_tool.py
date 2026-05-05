"""Memory v2 PR 14 — ``memory_categories`` tool unit tests.

Pins the Tier-1 progressive-disclosure surface: the agent calls
``memory_categories`` to get the vault's category map (with 1-line
descriptions, file counts, last-modified) before drilling deeper
via ``memory_list`` / ``memory_read``.

Sprint 3 cleanup A4 — ``MemoryIndexManager`` deleted; the tool now
calls ``manager.build_vault_map()`` directly. The fake manager
returns a hardcoded vault-map payload (the same shape the
executor's ``IndexHandle.build_vault_map`` produces) so the test
exercises the tool's response adapter without standing up a real
provider.
"""

from __future__ import annotations

import json
import sys
import types
from pathlib import Path
from typing import Any, Dict
from unittest.mock import patch

import pytest

# Light-touch package stubs so the tool's transitive imports
# (httpx / numpy through service.memory.__init__) don't have to be
# present in the test container. The real imports work fine in the
# deployed app.
BACKEND = Path(__file__).resolve().parents[2]


def _light_pkg(name: str, path: Path) -> None:
    if name in sys.modules:
        return
    pkg = types.ModuleType(name)
    pkg.__path__ = [str(path)]  # type: ignore[attr-defined]
    sys.modules[name] = pkg


_light_pkg("service", BACKEND / "service")
_light_pkg("service.memory", BACKEND / "service" / "memory")
_light_pkg("service.utils", BACKEND / "service" / "utils")


class _FakeManager:
    """Minimal SessionMemoryManager stand-in exposing ``build_vault_map``.

    Returns a hardcoded payload mirroring the executor's
    ``IndexHandle.build_vault_map`` shape so the tool's response
    adapter (sort by file_count desc, surface descriptions, etc.)
    is exercised without a real MemoryProvider.
    """

    def __init__(self, payload: Dict[str, Any]) -> None:
        self._payload = payload

    def build_vault_map(self):
        return dict(self._payload)


def _build_vault() -> _FakeManager:
    payload: Dict[str, Any] = {
        "categories": {
            "critical": {
                "files": 1,
                "last_modified": "2026-05-01T00:00:00",
                "description": (
                    "Always-pinned facts about the user, persona, and "
                    "binding decisions; injected into every prompt."
                ),
            },
            "topics": {
                "files": 1,
                "last_modified": "2026-05-01T00:00:00",
                "description": (
                    "Curated subject pages (free-form notes the agent "
                    "can read/write)."
                ),
            },
        },
        "top_tags": [],
        "recently_modified": [],
        "memory_md_preview": "",
        "total_files": 2,
        "generated_at": "2026-05-01T00:00:00",
    }
    return _FakeManager(payload)


def _run_tool(session_id: str, manager: _FakeManager) -> Dict[str, Any]:
    """Invoke ``MemoryCategoriesTool.run`` with the manager mocked
    in. Returns the parsed JSON response.
    """
    # Import lazily so the package stubs above are in place.
    from tools.built_in import memory_tools

    with patch.object(memory_tools, "_get_memory_manager", return_value=manager):
        tool = memory_tools.MemoryCategoriesTool()
        raw = tool.run(session_id=session_id)
    return json.loads(raw)


# ─────────────────────────────────────────────────────────────────


class TestMemoryCategoriesTool:
    def test_returns_categories_with_descriptions(self):
        manager = _build_vault()
        out = _run_tool("sid-1", manager)
        cats = out.get("categories")
        assert isinstance(cats, list) and len(cats) == 2
        # Sorted by file_count desc then category name asc — both
        # have file_count=1, so alphabetic.
        assert cats[0]["category"] == "critical"
        assert cats[1]["category"] == "topics"
        # Descriptions came from the vault map payload.
        assert cats[0]["description"]
        assert cats[1]["description"]
        assert "always-pinned" in cats[0]["description"].lower() \
            or "pinned" in cats[0]["description"].lower()
        assert out["total_files"] == 2
        assert "next_steps" in out

    def test_returns_error_when_session_missing(self):
        from tools.built_in import memory_tools

        with patch.object(memory_tools, "_get_memory_manager", return_value=None):
            raw = memory_tools.MemoryCategoriesTool().run(session_id="missing")
        assert json.loads(raw).get("error", "").startswith("Session not found")

    def test_returns_error_when_index_missing(self):
        class Bare:
            pass

        from tools.built_in import memory_tools

        with patch.object(memory_tools, "_get_memory_manager", return_value=Bare()):
            raw = memory_tools.MemoryCategoriesTool().run(session_id="x")
        assert json.loads(raw).get("error") == "Memory index not initialised"

    def test_appears_in_TOOLS_export(self):
        from tools.built_in import memory_tools

        names = [t.name for t in memory_tools.TOOLS]
        assert "memory_categories" in names
