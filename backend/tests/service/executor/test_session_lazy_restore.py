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
        self.resets = []

    def set_static_override(self, sid, prompt):
        self.overrides[sid] = prompt

    def reset(self, sid):
        self.resets.append(sid)


class _FakeBus:
    def __init__(self):
        self.events = []

    async def emit(self, event, sid, **kw):
        self.events.append((event, sid, kw))


class _FakeStore:
    def __init__(self, records):
        self._records = records
        self.updates = {}
        self.soft_deleted = []

    def soft_delete(self, sid):
        self.soft_deleted.append(sid)
        if sid in self._records:
            self._records[sid]["is_deleted"] = True

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
async def test_delete_dormant_session_soft_deletes_store_record():
    # The bug: a dormant (post-restart) session isn't in _local_agents, so
    # the old delete_session returned False → 404 "not found" and the
    # session was stuck visible-and-undeletable.
    mgr = _skeleton({"s1": {"session_id": "s1", "is_deleted": False, "storage_path": "/x"}})
    ok = await mgr.delete_session("s1")
    assert ok is True
    assert "s1" in mgr._store.soft_deleted
    assert mgr._store.get("s1")["is_deleted"] is True


@pytest.mark.asyncio
async def test_delete_unknown_session_returns_false():
    mgr = _skeleton({})
    assert await mgr.delete_session("ghost") is False


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


@pytest.mark.asyncio
async def test_propagate_env_update_flags_matching_live_sessions():
    # Editing env-A flags only the live sessions bound to env-A.
    mgr = _skeleton({})
    a1 = _FakeAgent("s1"); a1.env_id = "env-A"; a1._needs_manifest_reload = False
    a2 = _FakeAgent("s2"); a2.env_id = "env-A"; a2._needs_manifest_reload = False
    a3 = _FakeAgent("s3"); a3.env_id = "env-B"; a3._needs_manifest_reload = False
    mgr._local_agents = {"s1": a1, "s2": a2, "s3": a3}

    affected = await mgr.propagate_env_update("env-A")
    assert set(affected) == {"s1", "s2"}
    assert a1._needs_manifest_reload and a2._needs_manifest_reload
    assert not a3._needs_manifest_reload  # different env untouched


@pytest.mark.asyncio
async def test_ensure_live_reloads_a_manifest_dirty_session():
    mgr = _skeleton({})
    dirty = _FakeAgent("s1"); dirty.env_id = "env-A"; dirty._needs_manifest_reload = True
    mgr._local_agents = {"s1": dirty}
    reloaded = _FakeAgent("s1")
    calls = []

    async def _fake_reload(sid):
        calls.append(sid)
        mgr._local_agents[sid] = reloaded
        return reloaded

    mgr._reload_session_manifest = _fake_reload
    out = await mgr.ensure_session_live("s1")
    assert out is reloaded
    assert calls == ["s1"]


@pytest.mark.asyncio
async def test_ensure_live_does_not_reload_a_clean_session():
    mgr = _skeleton({})
    clean = _FakeAgent("s1"); clean.env_id = "env-A"; clean._needs_manifest_reload = False
    mgr._local_agents = {"s1": clean}

    async def _boom(sid):
        raise AssertionError("should not reload a clean session")

    mgr._reload_session_manifest = _boom
    assert await mgr.ensure_session_live("s1") is clean


@pytest.mark.asyncio
async def test_ensure_live_defers_reload_while_session_busy():
    # A turn in-flight (_is_executing) must NOT trigger a manifest reload —
    # tearing the pipeline down mid-turn would corrupt it. The flag stays set
    # so the rebuild lands on the next idle access.
    mgr = _skeleton({})
    busy = _FakeAgent("s1")
    busy.env_id = "env-A"
    busy._needs_manifest_reload = True
    busy._is_executing = True
    mgr._local_agents = {"s1": busy}

    async def _boom(sid):
        raise AssertionError("must not reload a busy session")

    mgr._reload_session_manifest = _boom
    out = await mgr.ensure_session_live("s1")
    assert out is busy                      # deferred — same agent returned
    assert busy._needs_manifest_reload is True  # flag retained for next access
