"""Agent → executor sub-agent bridge.

Pins the owned-companion spawn/delegate routing. The pre-cutover bespoke
paired-session mode has been removed; the executor SubAgentManager is the only
delegation mechanism.
"""

from __future__ import annotations

import types

import pytest

from service.vtuber import sub_agent_bridge as bridge


@pytest.mark.asyncio
async def test_spawn_owned_subagent_calls_manager_with_factory():
    calls = {}

    class _Mgr:
        async def spawn(self, agent_type, owner, *, factory=None, sub_agent_id=None,
                        credentials=None, parent_provider=None, system_prompt=None):
            calls.update(
                agent_type=agent_type, owner=owner, sub_agent_id=sub_agent_id,
                credentials=credentials, parent_provider=parent_provider,
                system_prompt=system_prompt, has_factory=factory is not None,
            )
            return types.SimpleNamespace(sub_agent_id=sub_agent_id)

    app_state = types.SimpleNamespace(subagent_manager=_Mgr())
    env_service = types.SimpleNamespace(load_manifest=lambda eid: object())
    sa_id = await bridge.spawn_owned_subagent(
        app_state, "vtuber9",
        parent_env_id="template-vtuber-env", env_service=env_service,
        system_prompt="role", credentials="creds", parent_provider="anthropic",
    )
    assert sa_id == "vtuber9-subagent"
    assert calls["owner"] == "vtuber9"
    assert calls["has_factory"] is True  # builds from the parent env
    assert calls["system_prompt"] == "role"
    assert calls["credentials"] == "creds"


@pytest.mark.asyncio
async def test_spawn_no_manager_returns_none():
    app_state = types.SimpleNamespace(subagent_manager=None)
    assert await bridge.spawn_owned_subagent(
        app_state, "v1", parent_env_id="e", env_service=object()
    ) is None


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
