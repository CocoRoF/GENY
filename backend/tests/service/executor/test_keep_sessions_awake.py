"""Keeping a session awake is a setting, and a per-session choice.

Eviction was written for a scale this host does not have. Measured on
production (2026-08-11) a resident session costs 64–87 MB, of which
64 MB was one embedder table each session held its own identical copy
of; with that table shared (adaptor 1.11.0) an extra resident session
costs 0–23 MB. What eviction buys in return is a cold start on the next
message — observed blowing its 90 s warm-up budget and letting a turn
proceed *without* memory.

So the host can now be told to leave sessions alone, and a single
session can be pinned regardless of what the host says. These tests pin
the resolution order and, more importantly, the two properties that
make it a setting rather than a build flag: it is read live, and a pin
survives the thing it protects against.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

from service.executor.agent_session_manager import (
    _EVICT_FLOOR_S,
    _coerce_evict_seconds,
)
from service.sessions.models import SessionStatus


# ── the threshold ────────────────────────────────────────────────────

def test_zero_means_never_and_survives_coercion():
    """0 is "never evict" and must not be lifted to the floor — that
    would turn "off" into "every 15 minutes"."""
    assert _coerce_evict_seconds(0, 1800.0) == 0.0
    assert _coerce_evict_seconds("0", 1800.0) == 0.0


def test_a_negative_value_is_invalid_input_not_a_quieter_zero():
    """The settings API saves out-of-range values and reports the error
    rather than rejecting them, so a typed ``-1`` reaches the runtime.
    Reading it as "never evict" would silently switch reclamation off on
    a host that asked for the opposite."""
    assert _coerce_evict_seconds(-1, 1800.0) == 1800.0
    assert _coerce_evict_seconds(-99999, 900.0) == 900.0


def test_small_values_are_lifted_off_the_idle_transition():
    """A threshold just above the IDLE transition would tear a session
    down the moment it fell asleep."""
    assert _coerce_evict_seconds(60, 1800.0) == _EVICT_FLOOR_S
    assert _coerce_evict_seconds(899, 1800.0) == _EVICT_FLOOR_S
    assert _coerce_evict_seconds(1800, 1800.0) == 1800.0


def test_garbage_falls_back_rather_than_disabling_eviction():
    """A typo in the environment must not silently mean "never reclaim"."""
    assert _coerce_evict_seconds("어쩌구", 1800.0) == 1800.0
    assert _coerce_evict_seconds(None, 1800.0) == 1800.0


# ── the setting is read live ─────────────────────────────────────────

class _StubManager:
    """Only the parts `_evict_seconds` touches."""

    _idle_evict_seconds = 1800.0

    from service.executor.agent_session_manager import AgentSessionManager as _M
    _evict_seconds = _M._evict_seconds


def _with_config(monkeypatch, *, keep_awake, evict=1800):
    cfg = SimpleNamespace(keep_sessions_awake=keep_awake, idle_evict_seconds=evict)
    import service.config as config_mod

    monkeypatch.setattr(
        config_mod, "get_config_manager",
        lambda: SimpleNamespace(load_config=lambda _cls: cfg),
        raising=False,
    )
    return cfg


def test_keep_awake_setting_disables_eviction(monkeypatch):
    _with_config(monkeypatch, keep_awake=True, evict=1800)
    assert _StubManager()._evict_seconds() == 0.0


def test_setting_change_takes_effect_without_restart(monkeypatch):
    """The whole reason this is resolved per scan and not cached in
    __init__: flipping it in settings has to land on the next tick."""
    mgr = _StubManager()
    cfg = _with_config(monkeypatch, keep_awake=False, evict=1800)
    assert mgr._evict_seconds() == 1800.0

    cfg.keep_sessions_awake = True
    assert mgr._evict_seconds() == 0.0, (
        "the manager cached the policy — a settings change would need a "
        "redeploy to take effect"
    )

    cfg.keep_sessions_awake = False
    cfg.idle_evict_seconds = 3600
    assert mgr._evict_seconds() == 3600.0


def test_unreadable_config_falls_back_to_the_previous_behaviour(monkeypatch):
    """A broken settings store must not change how the host behaves."""
    import service.config as config_mod

    def _boom():
        raise RuntimeError("config store down")

    monkeypatch.setattr(config_mod, "get_config_manager", _boom, raising=False)
    assert _StubManager()._evict_seconds() == 1800.0


# ── who is exempt ────────────────────────────────────────────────────

class _FakeAgent:
    def __init__(self, *, always_on, idle_for_s=99999):
        self.status = SessionStatus.IDLE
        self._is_always_on = always_on
        self._session_id = "s-1"
        self._execution_start_time = datetime.now() - timedelta(seconds=idle_for_s)


class _CandidateManager:
    from service.executor.agent_session_manager import AgentSessionManager as _M
    _is_evict_candidate = _M._is_evict_candidate

    def _session_busy(self, *_a, **_k):
        return False


@pytest.mark.parametrize("always_on,expected", [(False, True), (True, False)])
def test_pinned_sessions_are_never_candidates(always_on, expected):
    mgr = _CandidateManager()
    agent = _FakeAgent(always_on=always_on)
    assert mgr._is_evict_candidate(agent, datetime.now(), 1800.0) is expected


def test_threshold_is_the_one_passed_in_not_a_stored_one():
    """`_is_evict_candidate` takes the threshold as an argument so every
    session in a scan is judged against the same, freshly-resolved value."""
    mgr = _CandidateManager()
    agent = _FakeAgent(always_on=False, idle_for_s=1000)
    assert mgr._is_evict_candidate(agent, datetime.now(), 900.0) is True
    assert mgr._is_evict_candidate(agent, datetime.now(), 1800.0) is False


# ── the per-session pin ──────────────────────────────────────────────

def test_resolution_order_user_then_role_then_host(monkeypatch):
    """Explicit beats implicit, both ways round."""
    import service.executor.agent_session as sess_mod
    from service.sessions.models import SessionRole

    class _S:
        _is_always_on = sess_mod.AgentSession._is_always_on
        set_always_on = sess_mod.AgentSession.set_always_on

        def __init__(self, role, override=None):
            self._role = role
            self._always_on_override = override

    monkeypatch.setattr(sess_mod, "_host_keeps_sessions_awake", lambda: False)

    # 2) role rule
    assert _S(SessionRole.VTUBER)._is_always_on is True
    assert _S(SessionRole.WORKER)._is_always_on is False

    # 1) the user's choice outranks the role AND the host
    assert _S(SessionRole.VTUBER, override=False)._is_always_on is False
    assert _S(SessionRole.WORKER, override=True)._is_always_on is True

    # 3) host policy decides when nobody else did
    monkeypatch.setattr(sess_mod, "_host_keeps_sessions_awake", lambda: True)
    assert _S(SessionRole.WORKER)._is_always_on is True
    assert _S(SessionRole.WORKER, override=False)._is_always_on is False, (
        "un-pinning a session must still mean something while the host "
        "keeps everything else awake"
    )


def test_host_policy_reads_the_setting_live(monkeypatch):
    import service.executor.agent_session as sess_mod
    import service.config as config_mod

    cfg = SimpleNamespace(keep_sessions_awake=False, idle_evict_seconds=1800)
    monkeypatch.setattr(
        config_mod, "get_config_manager",
        lambda: SimpleNamespace(load_config=lambda _cls: cfg),
        raising=False,
    )
    assert sess_mod._host_keeps_sessions_awake() is False
    cfg.keep_sessions_awake = True
    assert sess_mod._host_keeps_sessions_awake() is True


def test_host_policy_falls_back_to_env(monkeypatch):
    import service.executor.agent_session as sess_mod
    import service.config as config_mod

    monkeypatch.setattr(
        config_mod, "get_config_manager",
        lambda: (_ for _ in ()).throw(RuntimeError("down")),
        raising=False,
    )
    monkeypatch.setenv("GENY_KEEP_SESSIONS_AWAKE", "true")
    assert sess_mod._host_keeps_sessions_awake() is True
    monkeypatch.setenv("GENY_KEEP_SESSIONS_AWAKE", "")
    assert sess_mod._host_keeps_sessions_awake() is False


# ── the setting itself ───────────────────────────────────────────────

def test_config_is_registered_and_shaped():
    import service.config  # noqa: F401 — triggers sub_config auto-discovery
    from service.config.base import get_registered_configs
    from service.config.sub_config.general.session_lifecycle_config import (
        SessionLifecycleConfig,
    )

    assert get_registered_configs().get("session_lifecycle") is SessionLifecycleConfig, (
        "the setting is not discoverable — it would never appear in the "
        "settings UI"
    )
    names = {f.name for f in SessionLifecycleConfig.get_fields_metadata()}
    assert names == {
        "keep_sessions_awake", "idle_evict_seconds", "idle_transition_seconds",
    }
    # Every field must actually reach the runtime, or it is decoration.
    for f in SessionLifecycleConfig.get_fields_metadata():
        assert f.apply_change is not None, f"{f.name} does not apply anywhere"
