"""Pack create/test orchestration — save_pack snapshots the workspace + persists;
test_tool runs a spec in the workspace. GAPT + container exec are faked.
"""

from __future__ import annotations

from typing import Any, Dict, List

import pytest

from service.sandbox_tool_packs.builder import save_pack
from service.sandbox_tool_packs.builder import test_tool as run_tool
from service.sandbox_tool_packs.models import (
    PackSkill,
    SandboxToolPackDefinition,
    SandboxToolSpec,
)


class _FakeGapt:
    def __init__(self) -> None:
        self.calls: List[str] = []

    async def run_command(self, ws, cmd, *, cwd=None):
        self.calls.append(f"run_command:{ws}")
        return "ok"

    async def create_snapshot(self, ws, *, label="", session_id=None, kind="manual", include_ignored=None):
        self.calls.append(f"create_snapshot:{ws}:{kind}:{include_ignored}")
        return {"id": "SNAPNEW1", "kind": kind, "git_sha": "abc123"}


class _FakeStore:
    def __init__(self) -> None:
        self.rows: Dict[str, SandboxToolPackDefinition] = {}

    def create(self, defn: SandboxToolPackDefinition) -> SandboxToolPackDefinition:
        self.rows[defn.id] = defn
        return defn

    def get(self, pack_id: str) -> SandboxToolPackDefinition:
        return self.rows[pack_id]

    def replace(self, pack_id: str, defn: SandboxToolPackDefinition) -> SandboxToolPackDefinition:
        self.rows[pack_id] = defn
        return defn


def _spec() -> SandboxToolSpec:
    return SandboxToolSpec(name="weather", entrypoint="tools/weather/main.py")


@pytest.mark.asyncio
async def test_save_pack_snapshots_and_persists() -> None:
    gapt, store = _FakeGapt(), _FakeStore()
    pack = await save_pack(
        store, gapt,
        name="weather-pack", description="w",
        project_ref="geny", workspace_ref="WS1",
        tools=[_spec()],
        skills=[PackSkill(id="howto", body="# how")],
        created_by="admin",
    )
    # tool_save snapshot with artifacts included.
    assert "create_snapshot:WS1:tool_save:True" in gapt.calls
    assert pack.snapshot_ref == "SNAPNEW1"
    assert pack.workspace_ref == "WS1" and pack.project_ref == "geny"
    assert pack.enabled is False            # code → owner confirms
    assert [t.name for t in pack.tools] == ["weather"]
    assert store.rows[pack.id] is pack


@pytest.mark.asyncio
async def test_save_pack_requires_a_tool() -> None:
    with pytest.raises(ValueError):
        await save_pack(
            _FakeStore(), _FakeGapt(),
            name="empty", project_ref="geny", workspace_ref="WS1", tools=[],
        )


@pytest.mark.asyncio
async def test_test_tool_runs_spec_in_workspace(monkeypatch) -> None:
    async def _fake_exec(sandbox, argv, *, cwd, input_bytes=None, env=None, timeout_s=120.0, launcher="docker"):
        await sandbox.ensure()
        return (0, b'{"temp": 19}', b"")

    monkeypatch.setattr(
        "geny_executor.tools.built_in.sandbox_exec_tool.sandbox_exec", _fake_exec
    )
    out = await run_tool(
        _FakeGapt(),
        project_ref="geny", workspace_ref="WS1",
        spec=_spec(), sample_input={"city": "Seoul"},
    )
    assert out["ok"] is True and out["is_error"] is False
    assert out["output"] == '{"temp": 19}'
