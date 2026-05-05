"""Memory v2 PR 14 — ``memory_categories`` tool unit tests.

Pins the Tier-1 progressive-disclosure surface: the agent calls
``memory_categories`` to get the vault's category map (with 1-line
descriptions, file counts, last-modified) before drilling deeper
via ``memory_list`` / ``memory_read``.
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


from service.memory.frontmatter import render_frontmatter  # noqa: E402
from service.memory.index import MemoryIndexManager  # noqa: E402


class _FakeManager:
    """Minimal SessionMemoryManager stand-in exposing ``build_vault_map``.

    Sprint 3 step 4 — ``MemoryCategoriesTool`` now calls
    ``manager.build_vault_map()`` directly; the legacy
    ``manager.index_manager.build_vault_map()`` chain was retired.
    The fake delegates to a real ``MemoryIndexManager`` to keep the
    integration shape (vault-map payload) realistic.
    """

    def __init__(self, idx_mgr: MemoryIndexManager) -> None:
        self._idx_mgr = idx_mgr

    def build_vault_map(self):
        return self._idx_mgr.build_vault_map()


def _build_vault(tmp_path: Path) -> _FakeManager:
    memory_dir = tmp_path / "memory"
    memory_dir.mkdir()
    (memory_dir / "topics").mkdir()
    (memory_dir / "topics" / "a.md").write_text(
        render_frontmatter(
            {"title": "A", "category": "topics", "importance": "medium"},
            "body of a",
        ),
        encoding="utf-8",
    )
    (memory_dir / "critical").mkdir()
    (memory_dir / "critical" / "name.md").write_text(
        render_frontmatter(
            {"title": "name", "category": "critical", "importance": "critical"},
            "Ellen",
        ),
        encoding="utf-8",
    )
    idx_mgr = MemoryIndexManager(str(memory_dir))
    idx_mgr.rebuild()
    return _FakeManager(idx_mgr)


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
    def test_returns_categories_with_descriptions(self, tmp_path: Path):
        manager = _build_vault(tmp_path)
        out = _run_tool("sid-1", manager)
        cats = out.get("categories")
        assert isinstance(cats, list) and len(cats) == 2
        # Sorted by file_count desc then category name asc — both
        # have file_count=1, so alphabetic.
        assert cats[0]["category"] == "critical"
        assert cats[1]["category"] == "topics"
        # Descriptions came from the constants table on the index.
        assert cats[0]["description"]
        assert cats[1]["description"]
        assert "always-pinned" in cats[0]["description"].lower() \
            or "pinned" in cats[0]["description"].lower()
        assert out["total_files"] == 2
        assert "next_steps" in out

    def test_returns_error_when_session_missing(self, tmp_path: Path):
        from tools.built_in import memory_tools

        with patch.object(memory_tools, "_get_memory_manager", return_value=None):
            raw = memory_tools.MemoryCategoriesTool().run(session_id="missing")
        assert json.loads(raw).get("error", "").startswith("Session not found")

    def test_returns_error_when_index_missing(self, tmp_path: Path):
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
