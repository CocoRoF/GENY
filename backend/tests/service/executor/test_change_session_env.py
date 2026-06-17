"""change_session_env — rebind a session to a different environment.

Pins AgentSessionManager.change_session_env:
  * validates the session exists (404) and the target env exists (400)
  * persists the new env_id to the store (so get_creation_params / _rehydrate
    pick it up on the next reload — the binding survives restart)
  * flags a LIVE session for a between-turn manifest reload
  * a DORMANT session (not in _local_agents) still rebinds (live=False)
"""

from __future__ import annotations

import pytest

from service.executor.agent_session_manager import AgentSessionManager


class _FakeAgent:
    def __init__(self, session_id: str, env_id: str | None = None):
        self.session_id = session_id
        self._env_id = env_id
        self._needs_manifest_reload = False

    @property
    def env_id(self):
        return self._env_id


class _FakeStore:
    def __init__(self, records):
        self._records = records
        self.updates = {}

    def get(self, sid):
        return self._records.get(sid)

    def update(self, sid, updates):
        self.updates.setdefault(sid, {}).update(updates)
        if sid in self._records:
            self._records[sid].update(updates)


class _FakeEnvService:
    """load_manifest returns a truthy object for known envs, None otherwise."""

    def __init__(self, known):
        self._known = set(known)

    def load_manifest(self, env_id):
        return object() if env_id in self._known else None


def _mgr(records, known_envs):
    mgr = object.__new__(AgentSessionManager)
    mgr._local_agents = {}
    mgr._store = _FakeStore(records)
    mgr._environment_service = _FakeEnvService(known_envs)
    # Skip the credential probe — None provider means "no check".
    mgr._extract_primary_provider = lambda env_id: None
    return mgr


@pytest.mark.asyncio
async def test_rebind_live_session_updates_store_and_flags_reload():
    mgr = _mgr(
        {"s1": {"session_id": "s1", "env_id": "old-env"}},
        known_envs={"old-env", "new-env"},
    )
    agent = _FakeAgent("s1", env_id="old-env")
    mgr._local_agents["s1"] = agent

    result = await mgr.change_session_env("s1", "new-env")

    assert result["env_id"] == "new-env"
    assert result["previous_env_id"] == "old-env"
    assert result["live"] is True
    # store persisted (survives reload / restart via get_creation_params)
    assert mgr._store.updates["s1"]["env_id"] == "new-env"
    # live agent flagged for between-turn reload
    assert agent._env_id == "new-env"
    assert agent._needs_manifest_reload is True


@pytest.mark.asyncio
async def test_rebind_dormant_session_persists_without_live_agent():
    mgr = _mgr(
        {"s1": {"session_id": "s1", "env_id": "old-env"}},
        known_envs={"old-env", "new-env"},
    )
    # not in _local_agents → dormant
    result = await mgr.change_session_env("s1", "new-env")
    assert result["live"] is False
    assert mgr._store.updates["s1"]["env_id"] == "new-env"


@pytest.mark.asyncio
async def test_rebind_unknown_session_raises():
    mgr = _mgr({}, known_envs={"new-env"})
    with pytest.raises(ValueError) as ei:
        await mgr.change_session_env("ghost", "new-env")
    assert "session not found" in str(ei.value)


@pytest.mark.asyncio
async def test_rebind_unknown_env_raises():
    mgr = _mgr(
        {"s1": {"session_id": "s1", "env_id": "old-env"}},
        known_envs={"old-env"},
    )
    with pytest.raises(ValueError) as ei:
        await mgr.change_session_env("s1", "does-not-exist")
    assert "environment not found" in str(ei.value)
    # store left untouched on failure
    assert "s1" not in mgr._store.updates


@pytest.mark.asyncio
async def test_rebind_blocked_when_provider_has_no_credentials():
    mgr = _mgr(
        {"s1": {"session_id": "s1", "env_id": "old-env"}},
        known_envs={"old-env", "new-env"},
    )
    # Force a provider with no creds.
    mgr._extract_primary_provider = lambda env_id: "anthropic"

    class _NoCreds:
        def has(self, _provider):
            return False

    import service.executor.credentials as creds_mod

    orig = creds_mod.CredentialBundleBuilder
    creds_mod.CredentialBundleBuilder = lambda *a, **k: type(
        "_B", (), {"build": lambda self: _NoCreds()}
    )()
    try:
        with pytest.raises(ValueError) as ei:
            await mgr.change_session_env("s1", "new-env")
        assert "자격증명" in str(ei.value)
    finally:
        creds_mod.CredentialBundleBuilder = orig
