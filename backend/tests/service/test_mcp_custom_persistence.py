"""Custom MCP server persistence (2026-06-10 vanishing-servers incident).

User-registered MCP servers were written to ``<backend>/mcp/custom/`` —
INSIDE the container image filesystem — so every ``docker compose up -d``
recreated the container and silently deleted them. The per-env manifest
snapshots (on the /data volume) survived, which made the symptom
maximally confusing: the server showed in the environment editor but
vanished from the MCP tab after every deploy.

The fix routes both the writer (mcp_custom_controller) and the reader
(MCPLoader) through one resolver honouring ``MCP_CUSTOM_STORAGE_PATH``
(prod compose points it at the /data volume), with a copy-once
migration from the legacy path.
"""

from __future__ import annotations

import json
from pathlib import Path

from service.mcp_loader import resolve_custom_mcp_dir


def test_default_is_legacy_path(monkeypatch):
    monkeypatch.delenv("MCP_CUSTOM_STORAGE_PATH", raising=False)
    d = resolve_custom_mcp_dir()
    assert d.as_posix().endswith("mcp/custom")


def test_env_override_creates_and_wins(tmp_path, monkeypatch):
    target = tmp_path / "persistent" / "custom"
    monkeypatch.setenv("MCP_CUSTOM_STORAGE_PATH", str(target))
    d = resolve_custom_mcp_dir(tmp_path / "image-mcp")
    assert d == target
    assert target.is_dir()


def test_migration_copies_legacy_jsons_once(tmp_path, monkeypatch):
    legacy_root = tmp_path / "image-mcp"
    legacy = legacy_root / "custom"
    legacy.mkdir(parents=True)
    (legacy / "gapt-service.json").write_text(
        json.dumps({"type": "stdio", "command": "npx", "args": ["gapt-mcp"]})
    )
    target = tmp_path / "data" / "mcp" / "custom"
    monkeypatch.setenv("MCP_CUSTOM_STORAGE_PATH", str(target))

    d = resolve_custom_mcp_dir(legacy_root)
    assert d == target
    migrated = json.loads((target / "gapt-service.json").read_text())
    assert migrated["command"] == "npx"

    # Copy, not move — rollback to an older image keeps working.
    assert (legacy / "gapt-service.json").exists()

    # Re-resolve does not clobber a newer copy in the target.
    (target / "gapt-service.json").write_text(json.dumps({"type": "stdio", "command": "edited"}))
    resolve_custom_mcp_dir(legacy_root)
    assert json.loads((target / "gapt-service.json").read_text())["command"] == "edited"


def test_unusable_override_falls_back_to_legacy(tmp_path, monkeypatch):
    # A path under a FILE cannot be mkdir'd → OSError → legacy fallback.
    blocker = tmp_path / "blocker"
    blocker.write_text("file, not dir")
    monkeypatch.setenv("MCP_CUSTOM_STORAGE_PATH", str(blocker / "custom"))
    d = resolve_custom_mcp_dir(tmp_path / "image-mcp")
    assert d == tmp_path / "image-mcp" / "custom"


def test_controller_and_loader_share_one_dir(tmp_path, monkeypatch):
    """Writer (controller) and reader (loader) must resolve identically —
    a split here recreates the incident as a silent read/write mismatch."""
    target = tmp_path / "data-mcp-custom"
    monkeypatch.setenv("MCP_CUSTOM_STORAGE_PATH", str(target))

    from controller.mcp_custom_controller import _custom_dir
    from service.mcp_loader import MCPLoader

    assert _custom_dir() == target
    loader = MCPLoader(mcp_dir=tmp_path / "image-mcp")
    assert loader.custom_dir == target
