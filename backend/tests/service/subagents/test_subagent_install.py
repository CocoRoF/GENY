"""Geny consumes the executor's persistent SubAgentManager (PR-3a/PR-4).

Pins the lifecycle→task-registry mirror: a sub-agent assignment surfaces as a
background-task record (running → done/failed), scoped to the owning session so
the 작업 tab renders it. The sub-agent runs in the executor; these are mirror
records, never re-executed by the task runner.
"""

from __future__ import annotations

import types

import pytest

pytest.importorskip("geny_executor")

from geny_executor.stages.s13_task_registry import TaskStatus  # noqa: E402
from geny_executor.stages.s12_agent.subagent_type import (  # noqa: E402
    SubagentTypeDescriptor,
    SubagentTypeRegistry,
)
from geny_executor.stages.s12_agent.persistent_subagent import (  # noqa: E402
    SubAgentManager,
)
from service.subagents import install_subagent_manager  # noqa: E402


class _Result:
    def __init__(self, text="ok", success=True):
        self.text = text
        self.success = success
        self.error = None


class _FakePipeline:
    async def run(self, task, state):
        return _Result(text=f"done:{task}")

    async def aclose(self):
        pass


class _FakeRegistry:
    """Minimal TaskRegistry stand-in capturing register/update_status."""

    def __init__(self):
        self.records = {}

    def register(self, record):
        self.records[record.task_id] = record

    def update_status(self, task_id, status, *, result=None, error=None):
        rec = self.records.get(task_id)
        if rec is not None:
            rec.status = status
            if result is not None:
                rec.result = result
            if error is not None:
                rec.error = error
        return rec


def _registry_with_worker():
    reg = SubagentTypeRegistry()
    reg.register(
        SubagentTypeDescriptor(agent_type="worker", factory=lambda ctx: _FakePipeline())
    )
    return reg


def test_install_returns_manager():
    app_state = types.SimpleNamespace(task_registry=_FakeRegistry())
    mgr = install_subagent_manager(app_state, registry=_registry_with_worker())
    assert isinstance(mgr, SubAgentManager)


def test_install_none_registry_returns_none():
    app_state = types.SimpleNamespace(task_registry=_FakeRegistry())
    assert install_subagent_manager(app_state, registry=None) is None


@pytest.mark.asyncio
async def test_assignment_surfaces_as_task_record():
    task_reg = _FakeRegistry()
    app_state = types.SimpleNamespace(task_registry=task_reg)
    mgr = install_subagent_manager(app_state, registry=_registry_with_worker())

    await mgr.spawn("worker", "ownerX", sub_agent_id="sa1")
    rec = await mgr.assign("sa1", "do a thing", background=False)

    aid = rec["assignment_id"]
    # mirror record exists, scoped to the owner session, terminal=DONE
    assert aid in task_reg.records
    mirror = task_reg.records[aid]
    assert mirror.kind == "subagent"
    assert mirror.payload["_session_id"] == "ownerX"
    assert mirror.payload["sub_agent_id"] == "sa1"
    assert mirror.status == TaskStatus.DONE


@pytest.mark.asyncio
async def test_failed_assignment_surfaces_failed():
    class _FailPipe:
        async def run(self, task, state):
            raise RuntimeError("nope")

        async def aclose(self):
            pass

    reg = SubagentTypeRegistry()
    reg.register(SubagentTypeDescriptor(agent_type="worker", factory=lambda ctx: _FailPipe()))
    task_reg = _FakeRegistry()
    app_state = types.SimpleNamespace(task_registry=task_reg)
    mgr = install_subagent_manager(app_state, registry=reg)

    await mgr.spawn("worker", "ownerX", sub_agent_id="sa1")
    rec = await mgr.assign("sa1", "t", background=False)
    mirror = task_reg.records[rec["assignment_id"]]
    assert mirror.status == TaskStatus.FAILED
    assert mirror.error
