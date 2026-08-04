"""Memory-readiness gate for self-initiated speech (2026-08-03).

Firing a thinking trigger on a cold session used to rehydrate it and speak
BEFORE the long-term layers finished warming — the persona greeted its owner
like a stranger. The gate defers the fire through _warm_then_fire (rehydrate
→ wait_memory_ready → re-enter), and the re-entry bypasses the gate via the
_warming membership so a capped warm-up still speaks.
"""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

import pytest

from service.vtuber.thinking_trigger import ThinkingTriggerService


class _StubAgent:
    def __init__(self, ready: bool):
        self._ready = ready
        self.wait_calls: list[float] = []

    def memory_ready(self) -> bool:
        return self._ready

    async def wait_memory_ready(self, timeout: float = 8.0) -> bool:
        self.wait_calls.append(timeout)
        self._ready = True
        return True


class _StubManager:
    def __init__(self, live_agent):
        self._live = live_agent
        self.ensure_calls: list[str] = []

    def get_agent(self, sid):
        return self._live

    async def ensure_session_live(self, sid):
        self.ensure_calls.append(sid)
        if self._live is None:
            self._live = _StubAgent(ready=False)
        return self._live


def _patch_manager(monkeypatch, mgr):
    import service.executor.agent_session_manager as mod

    monkeypatch.setattr(mod, "get_agent_session_manager", lambda: mgr)


@pytest.mark.asyncio
async def test_cold_session_defers_and_warm_fires(monkeypatch):
    svc = ThinkingTriggerService()
    mgr = _StubManager(live_agent=None)  # not live → cold
    _patch_manager(monkeypatch, mgr)

    fired: list[str] = []

    async def fake_fire(sid, **kw):
        # Simulate the re-entry: gate must be bypassed because sid ∈ _warming.
        assert sid in svc._warming
        fired.append(sid)

    # First entry hits the real gate; the deferred re-entry is fake_fire.
    real_fire = svc._fire_trigger
    calls = {"n": 0}

    async def gated_then_fake(sid, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            await real_fire(sid, **kw)  # goes through the gate → defers
        else:
            await fake_fire(sid, **kw)

    monkeypatch.setattr(svc, "_fire_trigger", gated_then_fake)

    await svc._fire_trigger("sess-1")
    # Let the spawned _warm_then_fire task run.
    for _ in range(20):
        if fired:
            break
        await asyncio.sleep(0.01)

    assert mgr.ensure_calls == ["sess-1"], "cold session must be rehydrated"
    assert fired == ["sess-1"], "deferred trigger must fire after warm-up"
    assert "sess-1" not in svc._warming, "warming membership must be released"


@pytest.mark.asyncio
async def test_ready_session_passes_gate(monkeypatch):
    svc = ThinkingTriggerService()
    agent = _StubAgent(ready=True)
    _patch_manager(monkeypatch, agent and _StubManager(live_agent=agent))

    picked: list[str] = []
    # Stop right after the gate: _pick_category_and_prompt returning None makes
    # _fire_trigger a no-op past the gate.
    monkeypatch.setattr(
        svc, "_pick_category_and_prompt", lambda sid, is_exec: picked.append(sid) or None
    )

    await svc._fire_trigger("sess-2")
    assert picked == ["sess-2"], "ready session must reach category picking"
    assert "sess-2" not in svc._warming


@pytest.mark.asyncio
async def test_gate_fails_open_on_manager_error(monkeypatch):
    svc = ThinkingTriggerService()

    import service.executor.agent_session_manager as mod

    def boom():
        raise RuntimeError("manager unavailable")

    monkeypatch.setattr(mod, "get_agent_session_manager", boom)

    picked: list[str] = []
    monkeypatch.setattr(
        svc, "_pick_category_and_prompt", lambda sid, is_exec: picked.append(sid) or None
    )

    await svc._fire_trigger("sess-3")
    assert picked == ["sess-3"], "gate must fail OPEN, never mute the persona"
