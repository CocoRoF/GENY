"""VTuber → executor sub-agent bridge (PR-3b, flag-gated cutover).

Pins the flag resolution + the executor-mode spawn/delegate routing. Default
mode is bespoke (zero regression); executor mode only activates with the env
flag AND a wired SubAgentManager.
"""

from __future__ import annotations

import types

import pytest

from service.vtuber import sub_agent_bridge as bridge


def test_mode_defaults_executor(monkeypatch):
    # Cutover: default is now executor.
    monkeypatch.delenv("GENY_VTUBER_SUBAGENT_MODE", raising=False)
    assert bridge.vtuber_subagent_mode() == "executor"


def test_mode_env_bespoke_rollback(monkeypatch):
    # The flag still allows rollback to bespoke.
    monkeypatch.setenv("GENY_VTUBER_SUBAGENT_MODE", "bespoke")
    assert bridge.vtuber_subagent_mode() == "bespoke"


def test_mode_env_invalid_falls_back_to_default(monkeypatch):
    monkeypatch.setenv("GENY_VTUBER_SUBAGENT_MODE", "nonsense")
    assert bridge.vtuber_subagent_mode() == "executor"


def test_executor_mode_active_requires_manager(monkeypatch):
    monkeypatch.delenv("GENY_VTUBER_SUBAGENT_MODE", raising=False)
    # default executor + manager → active
    assert bridge.executor_mode_active(types.SimpleNamespace(subagent_manager=object())) is True
    # executor but no manager → not active
    assert bridge.executor_mode_active(types.SimpleNamespace(subagent_manager=None)) is False
    # explicit bespoke rollback → not active even with manager
    monkeypatch.setenv("GENY_VTUBER_SUBAGENT_MODE", "bespoke")
    assert bridge.executor_mode_active(types.SimpleNamespace(subagent_manager=object())) is False


@pytest.mark.asyncio
async def test_spawn_vtuber_subagent_calls_manager():
    calls = {}

    class _Mgr:
        async def spawn(self, agent_type, owner, *, sub_agent_id=None, credentials=None, parent_provider=None):
            calls.update(
                agent_type=agent_type, owner=owner, sub_agent_id=sub_agent_id,
                credentials=credentials, parent_provider=parent_provider,
            )
            return types.SimpleNamespace(sub_agent_id=sub_agent_id)

    app_state = types.SimpleNamespace(subagent_manager=_Mgr())
    sa_id = await bridge.spawn_vtuber_subagent(
        app_state, "vtuber9", credentials="creds", parent_provider="anthropic"
    )
    assert sa_id == "vtuber9-subagent"
    assert calls["owner"] == "vtuber9"
    assert calls["agent_type"] == bridge.DEFAULT_SUBAGENT_TYPE
    assert calls["credentials"] == "creds"
    assert calls["parent_provider"] == "anthropic"


@pytest.mark.asyncio
async def test_spawn_no_manager_returns_none():
    app_state = types.SimpleNamespace(subagent_manager=None)
    assert await bridge.spawn_vtuber_subagent(app_state, "v1") is None


@pytest.mark.asyncio
async def test_delegate_calls_assign_background():
    seen = {}

    class _Mgr:
        async def assign(self, sub_agent_id, content, *, background=True):
            seen.update(sub_agent_id=sub_agent_id, content=content, background=background)
            return {"assignment_id": "a1", "status": "running"}

    app_state = types.SimpleNamespace(subagent_manager=_Mgr())
    out = await bridge.delegate_to_subagent(app_state, "sa1", "do it")
    assert out["status"] == "running"
    assert seen == {"sub_agent_id": "sa1", "content": "do it", "background": True}
