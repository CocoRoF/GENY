"""Sandbox Tool Pack loader — a pack becomes working tools + skills, bound to
its GAPT workspace, with cold-restore-from-snapshot. No live GAPT/Docker: the
GAPT client + the container exec are faked.
"""

from __future__ import annotations

from typing import Any, Dict, List, Tuple

import pytest

from service.gapt.client import GaptApiError
from service.sandbox_tool_packs.loader import (
    PackSandboxHandle,
    SandboxToolPackProvider,
    load_pack,
)
from service.sandbox_tool_packs.models import (
    PackSkill,
    SandboxToolPackDefinition,
    SandboxToolSpec,
)


def _pack(**over: Any) -> SandboxToolPackDefinition:
    base = dict(
        name="weather-pack",
        description="weather tools",
        project_ref="proj1",
        workspace_ref="WSPACK1",
        snapshot_ref="SNAP1",
        tools=[
            SandboxToolSpec(
                name="weather",
                description="get weather",
                entrypoint="tools/weather/main.py",
                input_schema={"type": "object", "properties": {"city": {"type": "string"}}},
            )
        ],
        skills=[PackSkill(id="weather-howto", description="how to use weather", body="# Weather\nCall weather with a city.")],
        enabled=True,
    )
    base.update(over)
    return SandboxToolPackDefinition(**base)


class _FakeGapt:
    """Records the calls PackSandboxHandle.ensure() makes."""

    def __init__(self, *, missing: bool = False) -> None:
        self.missing = missing
        self.calls: List[Tuple[str, tuple]] = []
        self._provisioned = False

    async def run_command(self, workspace_id: str, command: str, *, cwd=None):
        self.calls.append(("run_command", (workspace_id, command)))
        if self.missing and not self._provisioned:
            raise GaptApiError(404, "workspace.not_found", workspace_id)
        return "ok"

    async def create_workspace(self, project_id: str, *, name: str, selections=None):
        self.calls.append(("create_workspace", (project_id, name)))
        self._provisioned = True
        return {"id": "WSNEW1"}

    async def restore_snapshot(self, snapshot_id: str, *, target_workspace_id=None, clean=True):
        self.calls.append(("restore_snapshot", (snapshot_id, target_workspace_id)))
        return {"ok": True}


def test_load_pack_builds_tools_and_skills() -> None:
    gapt = _FakeGapt()
    tools, skills = load_pack(_pack(), gapt_client=gapt)
    assert [t.name for t in tools] == ["weather"]
    assert tools[0].input_schema["properties"]["city"]["type"] == "string"
    assert [s.id for s in skills] == ["weather-howto"]
    assert "Call weather" in skills[0].body
    # All tools share one handle pointing at the pack workspace.
    assert tools[0]._sandbox.container_name == "gapt-ws-wspack1"


@pytest.mark.asyncio
async def test_warm_workspace_just_boots() -> None:
    gapt = _FakeGapt(missing=False)
    handle = PackSandboxHandle(gapt, project_ref="proj1", workspace_ref="WSPACK1", snapshot_ref="SNAP1")
    await handle.ensure()
    await handle.ensure()  # idempotent — only one boot
    assert [c[0] for c in gapt.calls] == ["run_command"]
    assert handle.container_name == "gapt-ws-wspack1"


@pytest.mark.asyncio
async def test_cold_workspace_reprovisions_from_snapshot() -> None:
    gapt = _FakeGapt(missing=True)
    handle = PackSandboxHandle(gapt, project_ref="proj1", workspace_ref="WSPACK1", snapshot_ref="SNAP1")
    await handle.ensure()
    kinds = [c[0] for c in gapt.calls]
    # boot fails (404) → create workspace → boot it → restore from snapshot.
    assert kinds == ["run_command", "create_workspace", "run_command", "restore_snapshot"]
    # the handle now points at the freshly-provisioned workspace.
    assert handle.workspace_ref == "WSNEW1"
    assert gapt.calls[-1] == ("restore_snapshot", ("SNAP1", "WSNEW1"))


@pytest.mark.asyncio
async def test_tool_executes_in_pack_workspace(monkeypatch) -> None:
    # The loaded SandboxExecTool runs its script via the executor's sandbox_exec
    # against the pack handle. Fake sandbox_exec to simulate the container.
    captured: Dict[str, Any] = {}

    async def _fake_exec(sandbox, argv, *, cwd, input_bytes=None, env=None, timeout_s=120.0, launcher="docker"):
        await sandbox.ensure()  # exercises the handle boot
        captured["container"] = sandbox.container_name
        captured["argv"] = argv
        captured["stdin"] = input_bytes
        return (0, b'{"temp": 21}', b"")

    monkeypatch.setattr(
        "geny_executor.tools.built_in.sandbox_exec_tool.sandbox_exec", _fake_exec
    )
    from geny_executor.tools.base import ToolContext

    gapt = _FakeGapt()
    tools, _ = load_pack(_pack(), gapt_client=gapt)
    res = await tools[0].execute({"city": "Seoul"}, ToolContext())
    assert not res.is_error
    assert res.content == '{"temp": 21}'
    assert captured["container"] == "gapt-ws-wspack1"
    assert captured["argv"] == ["python3", "tools/weather/main.py"]
    assert b"Seoul" in captured["stdin"]
    assert ("run_command", ("WSPACK1", "true")) in gapt.calls  # handle booted it


def test_provider_aggregates_enabled_packs() -> None:
    gapt = _FakeGapt()

    class _Store:
        def list_enabled(self):
            return [
                _pack(name="weather-pack", workspace_ref="WSA"),
                _pack(
                    name="math-pack", workspace_ref="WSB",
                    tools=[SandboxToolSpec(name="add", entrypoint="tools/add/main.py")],
                    skills=[],
                ),
            ]

    prov = SandboxToolPackProvider(store=_Store(), gapt_client=gapt)
    assert set(prov.list_names()) == {"weather", "add"}
    assert prov.get("add").name == "add"
    assert prov.get("missing") is None
    # skills from the packs are exposed for the session to register.
    assert [s.id for s in prov.skills()] == ["weather-howto"]
