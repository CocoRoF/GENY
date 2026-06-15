"""Lazy session restore — survive redeploy / restart / crash.

Pins the routing of ``AgentSessionManager.ensure_session_live`` and the
reconstruction done by ``_rehydrate``:

  * live session → returned as-is, no re-hydration
  * dormant (non-deleted store record, not in memory) → re-hydrated
  * explicitly deleted record → None (stays gone)
  * unknown id → None
  * ``_rehydrate`` reuses the SAME session_id, forwards env_id, restores the
    system-prompt override + chat_room_id, and cascades to the linked peer.
"""

from __future__ import annotations

import pytest

from service.executor.agent_session_manager import AgentSessionManager
from service.sessions.models import SessionRole


class _FakeAgent:
    def __init__(self, session_id: str):
        self.session_id = session_id
        self._chat_room_id = None

    def get_session_info(self):
        return {"session_id": self.session_id}


class _FakePersona:
    def __init__(self):
        self.overrides = {}

    def set_static_override(self, sid, prompt):
        self.overrides[sid] = prompt


class _FakeBus:
    def __init__(self):
        self.events = []

    async def emit(self, event, sid, **kw):
        self.events.append((event, sid, kw))


class _FakeStore:
    def __init__(self, records):
        self._records = records
        self.updates = {}

    def get(self, sid):
        return self._records.get(sid)

    def list_active(self):
        return [r for r in self._records.values() if not r.get("is_deleted")]

    def update(self, sid, updates):
        self.updates.setdefault(sid, {}).update(updates)

    def get_creation_params(self, sid):
        rec = self._records.get(sid)
        if not rec:
            return None
        return {
            "session_name": rec.get("session_name"),
            "working_dir": rec.get("storage_path"),
            "model": rec.get("model"),
            "max_turns": rec.get("max_turns", 100),
            "timeout": rec.get("timeout", 21600),
            "max_iterations": rec.get("max_iterations", 100),
            "role": rec.get("role", "worker"),
            "graph_name": rec.get("graph_name"),
            "workflow_id": rec.get("workflow_id"),
            "tool_preset_id": rec.get("tool_preset_id"),
            "linked_session_id": rec.get("linked_session_id"),
            "session_type": rec.get("session_type"),
            "chat_room_id": rec.get("chat_room_id"),
            "trigger_preset_id": rec.get("trigger_preset_id"),
            "env_id": rec.get("env_id"),
        }


def _skeleton(records) -> AgentSessionManager:
    import asyncio

    mgr = object.__new__(AgentSessionManager)
    mgr._local_agents = {}
    mgr._rehydrate_locks = {}
    mgr._store = _FakeStore(records)
    mgr._persona_provider = _FakePersona()
    mgr._lifecycle_bus = _FakeBus()
    return mgr


@pytest.mark.asyncio
async def test_ensure_live_returns_existing_without_rehydrate():
    mgr = _skeleton({})
    existing = _FakeAgent("s1")
    mgr._local_agents["s1"] = existing

    called = {"n": 0}

    async def _boom(*a, **k):
        called["n"] += 1

    mgr._rehydrate = _boom
    out = await mgr.ensure_session_live("s1")
    assert out is existing
    assert called["n"] == 0  # already live → no reconstruction


@pytest.mark.asyncio
async def test_ensure_live_rehydrates_dormant():
    mgr = _skeleton({"s1": {"session_id": "s1", "is_deleted": False}})

    async def _fake_rehydrate(sid, *, cascade=True):
        agent = _FakeAgent(sid)
        mgr._local_agents[sid] = agent
        return agent

    mgr._rehydrate = _fake_rehydrate
    out = await mgr.ensure_session_live("s1")
    assert out is not None and out.session_id == "s1"
    assert "s1" in mgr._local_agents


@pytest.mark.asyncio
async def test_ensure_live_skips_deleted_and_unknown():
    mgr = _skeleton({"dead": {"session_id": "dead", "is_deleted": True}})

    async def _boom(*a, **k):
        raise AssertionError("should not rehydrate")

    mgr._rehydrate = _boom
    assert await mgr.ensure_session_live("dead") is None  # explicitly deleted
    assert await mgr.ensure_session_live("ghost") is None  # unknown id


@pytest.mark.asyncio
async def test_rehydrate_reuses_id_env_prompt_and_cascades():
    records = {
        "vt": {
            "session_id": "vt",
            "is_deleted": False,
            "role": "vtuber",
            "env_id": "env-vtuber",
            "system_prompt": "be kind",
            "chat_room_id": "room-1",
            "linked_session_id": "sub",
            "session_type": "vtuber",
        },
        "sub": {
            "session_id": "sub",
            "is_deleted": False,
            "role": "worker",
            "env_id": "env-worker",
            "linked_session_id": "vt",
            "session_type": "sub",
        },
    }
    mgr = _skeleton(records)
    created = []

    async def _fake_create(request, session_id=None, env_id=None, trigger_preset_id=None):
        created.append({"id": session_id, "env_id": env_id, "role": request.role})
        agent = _FakeAgent(session_id)
        mgr._local_agents[session_id] = agent
        return agent

    mgr.create_agent_session = _fake_create

    agent = await mgr._rehydrate("vt")

    assert agent.session_id == "vt"
    # same id + persisted env forwarded
    assert {"id": "vt", "env_id": "env-vtuber", "role": SessionRole.VTUBER} in created
    # cascade re-hydrated the linked sub-worker with its own id + env
    assert {"id": "sub", "env_id": "env-worker", "role": SessionRole.WORKER} in created
    # system prompt restored through the persona provider
    assert mgr._persona_provider.overrides["vt"] == "be kind"
    # chat room reattached
    assert agent._chat_room_id == "room-1"
    # SESSION_RESTORED emitted for both main and linked peer
    emitted = {sid for (_evt, sid, _kw) in mgr._lifecycle_bus.events}
    assert {"vt", "sub"} <= emitted
