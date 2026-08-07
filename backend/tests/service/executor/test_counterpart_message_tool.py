"""Regression tests for `SendDirectMessageInternalTool`.

WHAT THIS TOOL IS NOW

It delegates a task to the agent's OWN companion sub-agent, declared in the
environment (``host_selections.extras.owned_subagent``). The companion runs
autonomously; completion arrives later as an inbox alarm.

WHAT IT USED TO BE — and what this file used to assert — was a counterpart DM
(VTuber↔Sub-Worker, resolved from ``AgentSession._linked_session_id``) that
wrote to the recipient's inbox and fired a response trigger. Four tests here
still described that, so they ran against a tool that now answers "this agent
owns no sub-agent to delegate to" and did nothing else.

The one property that survived both designs is the reason the tool exists:
``target_session_id`` is NOT in the LLM-visible schema. The LLM used to be
asked to copy a UUID out of its system prompt, mistook the "## Sub-Worker
Agent" header for a session name, and created a new session to DM into. The
runtime resolves the target; the model cannot get it wrong.

See ``dev_docs/20260420_7/analysis/01_linked_counterpart_discovery.md``.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any, Dict, Optional

import pytest

from tools.base import _probe_param
from tools.built_in import geny_tools


# ─────────────────────────────────────────────────────────────────
# Fixtures — fakes for the manager/inbox/trigger singletons
# ─────────────────────────────────────────────────────────────────


@dataclass
class _SimpleContext:
    session_id: str


class _FakeAgent:
    def __init__(
        self,
        session_id: str,
        name: str,
        linked_id: Optional[str],
        companion_id: Optional[str] = None,
    ):
        self.session_id = session_id
        self.session_name = name
        self._linked_session_id = linked_id
        # The environment-declared companion this agent may delegate to.
        self._executor_sub_agent_id = companion_id


class _FakeManager:
    """Lookup table keyed by session_id; resolve_session falls back to name."""

    def __init__(self, agents: Dict[str, _FakeAgent]):
        self._by_id = agents
        self._by_name = {a.session_name: a for a in agents.values()}

    def get_agent(self, sid: str) -> Optional[_FakeAgent]:
        return self._by_id.get(sid)

    def resolve_session(self, name_or_id: str) -> Optional[_FakeAgent]:
        return self._by_id.get(name_or_id) or self._by_name.get(name_or_id)


class _FakeInbox:
    def __init__(self) -> None:
        self.delivered: list[Dict[str, Any]] = []

    def deliver(self, **kwargs: Any) -> Dict[str, Any]:
        msg = {
            "id": f"msg-{len(self.delivered) + 1}",
            "timestamp": "2026-04-21T15:30:00Z",
            **kwargs,
        }
        self.delivered.append(msg)
        return msg


@pytest.fixture
def patched_world(monkeypatch):
    """Wire fakes for every singleton the counterpart tool touches."""

    inbox = _FakeInbox()
    trigger_calls: list[Dict[str, Any]] = []

    def _install(agents: Dict[str, _FakeAgent]) -> _FakeInbox:
        manager = _FakeManager(agents)

        def _resolve(name_or_id: str):
            agent = manager.resolve_session(name_or_id)
            if agent is None:
                return (None, None)
            return (agent, agent.session_id)

        monkeypatch.setattr(geny_tools, "_get_agent_manager", lambda: manager)
        monkeypatch.setattr(geny_tools, "_get_inbox_manager", lambda: inbox)
        monkeypatch.setattr(geny_tools, "_resolve_session", _resolve)
        monkeypatch.setattr(
            geny_tools,
            "_trigger_dm_response",
            lambda **kwargs: trigger_calls.append(kwargs),
        )
        return inbox

    return _install, inbox, trigger_calls


# ─────────────────────────────────────────────────────────────────
# LLM-visible schema — target is NOT exposed
# ─────────────────────────────────────────────────────────────────


def test_schema_does_not_expose_target_session_id() -> None:
    tool = geny_tools.SendDirectMessageInternalTool()
    schema = tool.parameters
    props = schema.get("properties", {})
    assert "target_session_id" not in props, (
        "counterpart tool must not expose target_session_id; runtime "
        "resolves the target from _linked_session_id"
    )
    assert "content" in props


def test_probe_injects_session_id() -> None:
    """`session_id` is a declared run() parameter, so the probe recognises it
    and execute() injects ToolContext.session_id."""
    tool = geny_tools.SendDirectMessageInternalTool()
    assert _probe_param(tool, "session_id", kwargs_counts=True) is True


# ─────────────────────────────────────────────────────────────────
# Happy paths — symmetric delivery for both directions
# ─────────────────────────────────────────────────────────────────


# ─────────────────────────────────────────────────────────────────
# Delegation — what the tool actually does now
# ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_refuses_when_the_agent_owns_no_companion(patched_world) -> None:
    """No companion declared → nothing to delegate to. The refusal must be
    explicit AND side-effect free: a half-delivered task with no runner is
    worse than a clear error."""
    install, inbox, triggers = patched_world
    install({"solo-1": _FakeAgent("solo-1", "Solo", linked_id=None)})

    tool = geny_tools.SendDirectMessageInternalTool()
    result = await tool.execute({"content": "do the thing"}, _SimpleContext("solo-1"))

    payload = json.loads(result.content)
    assert "owns no sub-agent" in payload["error"]
    assert inbox.delivered == []
    assert triggers == []


@pytest.mark.asyncio
async def test_unknown_caller_session_is_reported_not_guessed(patched_world) -> None:
    install, inbox, triggers = patched_world
    install({})

    tool = geny_tools.SendDirectMessageInternalTool()
    result = await tool.execute({"content": "hi"}, _SimpleContext("ghost-1"))

    payload = json.loads(result.content)
    assert "caller session not found" in payload["error"]
    assert inbox.delivered == []


@pytest.mark.asyncio
async def test_hands_the_task_to_the_declared_companion(patched_world, monkeypatch) -> None:
    """With a companion declared, the content goes to THAT sub-agent and the
    tool returns immediately — the companion reports back through the inbox
    alarm, not through this call."""
    install, _inbox, _triggers = patched_world
    install({
        "vtuber-1": _FakeAgent(
            "vtuber-1", "VTuber", linked_id="sub-1", companion_id="executor-sa-9",
        ),
    })

    handed: list[tuple] = []

    async def _fake_delegate(_app_state, sa_id, content):
        handed.append((sa_id, content))

    import service.vtuber.sub_agent_bridge as bridge

    monkeypatch.setattr(bridge, "delegate_to_subagent", _fake_delegate)
    monkeypatch.setattr(
        geny_tools, "spawn_background",
        lambda coro, **kw: asyncio.get_running_loop().create_task(coro),
    )

    tool = geny_tools.SendDirectMessageInternalTool()
    result = await tool.execute(
        {"content": "please write notes.md"}, _SimpleContext("vtuber-1"),
    )

    await asyncio.sleep(0)  # let the detached hand-off run
    assert result.is_error is False, result.content
    assert handed == [("executor-sa-9", "please write notes.md")]
