"""A persona belongs to a session, not only to its environment.

Until now the only place a persona could be attached was
``host_selections.extras.persona_preset_id`` on an ENVIRONMENT. So giving
one session a different character meant building it another environment,
and changing one meant editing an environment every session on it shares.
There was also no way to say "apply it now" — every rebuild was a side
effect of changing something else.

These pin the resolution order, the persistence that makes an override
mean anything past the next reload, and the two ways a change lands
(immediately when idle, between turns when busy — never mid-answer).
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from service.executor.agent_session_manager import AgentSessionManager


class _Store:
    def __init__(self, rec=None):
        self.rec = rec if rec is not None else {}
        self.updates = []

    def get(self, _sid):
        return dict(self.rec) if self.rec is not None else None

    def update(self, sid, patch):
        self.updates.append((sid, patch))
        self.rec.update(patch)


def _mgr(rec=None, env_preset=None, busy=False, live=True):
    m = object.__new__(AgentSessionManager)
    m._store = _Store(rec if rec is not None else {"env_id": "env-1"})
    m._local_agents = {"s1": SimpleNamespace(_needs_manifest_reload=False)} if live else {}
    m._env_persona_preset_id = lambda _env: env_preset
    m._session_busy = lambda *_a, **_k: busy
    m.reloaded = []

    async def _reload(sid):
        m.reloaded.append(sid)
        return SimpleNamespace()

    m._reload_session_manifest = _reload
    return m


# ── resolution order ─────────────────────────────────────────────────

def test_the_environment_supplies_the_persona_when_the_session_has_none():
    m = _mgr(env_preset="env-persona")
    assert m.resolve_persona_preset_id("s1", "env-1") == ("env-persona", "environment")


def test_the_sessions_own_choice_wins():
    m = _mgr(rec={"env_id": "env-1", "persona_preset_id": "mine"},
             env_preset="env-persona")
    assert m.resolve_persona_preset_id("s1", "env-1") == ("mine", "session")


def test_nothing_anywhere_is_reported_as_such():
    """'none' is a real answer — the caller needs to distinguish "no
    persona" from "could not tell"."""
    m = _mgr(env_preset=None)
    assert m.resolve_persona_preset_id("s1", "env-1") == (None, "none")


def test_a_blank_override_is_not_an_override():
    m = _mgr(rec={"env_id": "env-1", "persona_preset_id": "   "},
             env_preset="env-persona")
    assert m.resolve_persona_preset_id("s1", "env-1") == ("env-persona", "environment")


def test_an_unreadable_store_falls_back_to_the_environment():
    """A broken store must not silently strip a session's persona."""
    m = _mgr(env_preset="env-persona")

    def _boom(_sid):
        raise RuntimeError("store down")

    m._store.get = _boom
    assert m.resolve_persona_preset_id("s1", "env-1") == ("env-persona", "environment")


# ── setting it ───────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_setting_a_persona_persists_before_it_applies(monkeypatch):
    """Persisted first: the override exists to survive eviction and
    restart, so writing it is the operation — the live rebuild only makes
    it take effect now."""
    m = _mgr()
    monkeypatch.setattr(
        "service.persona_presets.get_persona_preset_store",
        lambda: SimpleNamespace(get=lambda _i: SimpleNamespace(name="세라")),
    )
    out = await m.set_session_persona("s1", "p-9")
    assert m._store.updates == [("s1", {"persona_preset_id": "p-9"})]
    assert out["persona_preset_id"] == "p-9"
    assert out["applied_now"] is True
    assert m.reloaded == ["s1"]


@pytest.mark.asyncio
async def test_a_busy_session_is_flagged_not_torn_down(monkeypatch):
    """Rebuilding underneath a running answer is how you lose one."""
    m = _mgr(busy=True)
    monkeypatch.setattr(
        "service.persona_presets.get_persona_preset_store",
        lambda: SimpleNamespace(get=lambda _i: SimpleNamespace(name="세라")),
    )
    out = await m.set_session_persona("s1", "p-9")
    assert out["applied_now"] is False
    assert m.reloaded == []
    assert m._local_agents["s1"]._needs_manifest_reload is True


@pytest.mark.asyncio
async def test_clearing_hands_the_session_back_to_its_environment():
    m = _mgr(rec={"env_id": "env-1", "persona_preset_id": "mine"},
             env_preset="env-persona")
    out = await m.set_session_persona("s1", None)
    assert out["persona_preset_id"] is None
    assert out["effective_preset_id"] == "env-persona"
    assert out["persona_source"] == "environment"


@pytest.mark.asyncio
async def test_an_unknown_preset_is_refused(monkeypatch):
    """A persona that silently does not exist is worse than a refusal."""
    from service.persona_presets.store import PersonaPresetNotFound

    def _missing():
        def _get(_i):
            raise PersonaPresetNotFound(_i)
        return SimpleNamespace(get=_get)

    m = _mgr()
    monkeypatch.setattr("service.persona_presets.get_persona_preset_store", _missing)
    with pytest.raises(ValueError, match="persona preset not found"):
        await m.set_session_persona("s1", "ghost")
    assert m._store.updates == [], "an invalid persona was persisted anyway"


@pytest.mark.asyncio
async def test_an_unknown_session_is_refused():
    m = _mgr()
    m._store.rec = None
    with pytest.raises(ValueError, match="session not found"):
        await m.set_session_persona("nope", "p-9")


# ── restart ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_restart_rebuilds_a_live_idle_session():
    m = _mgr()
    out = await m.restart_session("s1")
    assert out["restarted"] is True
    assert m.reloaded == ["s1"]


@pytest.mark.asyncio
async def test_restart_refuses_mid_turn():
    m = _mgr(busy=True)
    with pytest.raises(RuntimeError):
        await m.restart_session("s1")
    assert m.reloaded == []


@pytest.mark.asyncio
async def test_restarting_a_dormant_session_is_a_no_op():
    """It builds from current state on next access — which is what a
    restart would have produced. Saying so beats pretending to work."""
    m = _mgr(live=False)
    out = await m.restart_session("s1")
    assert out["restarted"] is False
    assert out["reason"] == "dormant"


def test_the_override_survives_a_reload():
    """`get_creation_params` is what a rehydrate rebuilds from. Omitting
    the override there would revert the session to its environment's
    persona on the next wake — the thing the override exists to escape."""
    from service.sessions.store import SessionStore

    import inspect
    src = inspect.getsource(SessionStore.get_creation_params)
    assert '"persona_preset_id"' in src


# ── the mood the old persona left behind ─────────────────────────────

class _StateProvider:
    def __init__(self):
        self.patches = []

    async def set_absolute(self, cid, patch):
        self.patches.append((cid, patch))


def _mgr_with_state(rec=None, env_preset=None, mood="joy"):
    m = _mgr(rec=rec, env_preset=env_preset)
    m._state_provider = _StateProvider()
    m._preset_emotion = mood
    return m


def _patch_store(monkeypatch, mood="joy"):
    monkeypatch.setattr(
        "service.persona_presets.get_persona_preset_store",
        lambda: SimpleNamespace(
            get=lambda _i: SimpleNamespace(
                name="엘렌", emotion=SimpleNamespace(default_mood=mood),
            ),
        ),
    )


@pytest.mark.asyncio
async def test_a_persona_change_resets_the_mood_it_inherited(monkeypatch):
    """Swapping a persona changed what the agent was TOLD it is while
    leaving what it FEELS untouched. Production: a session moved onto an
    outgoing ESFP preset kept `calm: 0.98` from the previous character and
    every reply still came out calm."""
    m = _mgr_with_state()
    _patch_store(monkeypatch, mood="joy")
    out = await m.set_session_persona("s1", "p-new")
    assert out["mood_reset"] is True
    (_cid, patch), = m._state_provider.patches
    assert patch["mood.joy"] == m._PERSONA_BASELINE
    assert patch["mood.calm"] == 0.0, "the old resting mood survived the swap"


@pytest.mark.asyncio
async def test_neutral_means_no_peak(monkeypatch):
    """The live vector has six axes and 'neutral' is not one of them — it
    is the absence of a peak."""
    m = _mgr_with_state()
    _patch_store(monkeypatch, mood="neutral")
    await m.set_session_persona("s1", "p-new")
    (_cid, patch), = m._state_provider.patches
    assert set(patch.values()) == {0.0}


@pytest.mark.asyncio
async def test_reapplying_the_same_persona_keeps_the_mood(monkeypatch):
    """Emotional continuity is what makes the agent feel like itself. Only
    a real discontinuation should wipe it."""
    m = _mgr_with_state(rec={"env_id": "env-1", "persona_preset_id": "same"})
    _patch_store(monkeypatch)
    out = await m.set_session_persona("s1", "same")
    assert out["mood_reset"] is False
    assert m._state_provider.patches == []


@pytest.mark.asyncio
async def test_an_unwired_state_provider_is_not_an_error(monkeypatch):
    """Classic (non-creature) sessions have no mood to reset."""
    m = _mgr()
    m._state_provider = None
    _patch_store(monkeypatch)
    out = await m.set_session_persona("s1", "p-new")
    assert out["mood_reset"] is False
    assert out["success"] if "success" in out else True
