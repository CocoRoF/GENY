"""E.1 (cycle 20260426_1) — between-turn runtime refresh tests.

Verifies the queue + drain semantics of
``AgentSession.queue_runtime_refresh`` /
``AgentSession._apply_pending_runtime_refresh``. Direct method tests
against a fake Pipeline avoid spinning the full ``initialize`` path.
"""

from __future__ import annotations

import logging
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

# AgentSession transitively imports pydantic via service.sessions.models.
pytest.importorskip("pydantic")

from service.executor.agent_session import AgentSession  # noqa: E402


def _bare_session(*, initialized: bool = True, with_pipeline: bool = True) -> AgentSession:
    """Construct a minimal AgentSession without going through __init__,
    populating only the attrs the queue/drain helpers read."""
    s = AgentSession.__new__(AgentSession)
    s._session_id = "sx"
    s._initialized = initialized
    s._pipeline = (
        SimpleNamespace(
            _set_tool_stage_permission_matrix=MagicMock(),
            _set_tool_stage_hook_runner=MagicMock(),
        )
        if with_pipeline
        else None
    )
    s._pending_runtime_refresh = None
    return s


def test_queue_rejects_unknown_scope() -> None:
    s = _bare_session()
    assert s.queue_runtime_refresh("not-a-scope") is False
    assert s._pending_runtime_refresh is None


def test_queue_rejects_uninitialized_session() -> None:
    s = _bare_session(initialized=False)
    assert s.queue_runtime_refresh("permissions") is False


def test_queue_rejects_session_without_pipeline() -> None:
    s = _bare_session(with_pipeline=False)
    assert s.queue_runtime_refresh("permissions") is False


def test_queue_accepts_valid_scope() -> None:
    s = _bare_session()
    assert s.queue_runtime_refresh("permissions") is True
    assert s._pending_runtime_refresh == "permissions"


def test_apply_no_op_when_queue_empty() -> None:
    s = _bare_session()
    # Should not raise even when nothing's queued.
    s._apply_pending_runtime_refresh()
    s._pipeline._set_tool_stage_permission_matrix.assert_not_called()
    s._pipeline._set_tool_stage_hook_runner.assert_not_called()


def test_apply_clears_flag_even_on_failure(monkeypatch) -> None:
    """A failed reload must NOT leave the queue stuck — the flag is
    one-shot and clears before the install call."""
    s = _bare_session()
    s.queue_runtime_refresh("permissions")

    # Stub install_permission_rules to raise.
    import service.permission.install as perm_install

    def boom():
        raise RuntimeError("permission install failed")

    monkeypatch.setattr(perm_install, "install_permission_rules", boom)

    s._apply_pending_runtime_refresh()
    # Flag is cleared regardless of failure.
    assert s._pending_runtime_refresh is None


def test_apply_calls_permissions_setter(monkeypatch) -> None:
    """Happy path — install returns rules+mode; the executor's stage
    setter is called with them."""
    s = _bare_session()
    s.queue_runtime_refresh("permissions")

    import service.permission.install as perm_install

    fake_rules = ["rule1", "rule2"]
    fake_mode = "enforce"
    monkeypatch.setattr(
        perm_install,
        "install_permission_rules",
        lambda: (fake_rules, fake_mode),
    )

    s._apply_pending_runtime_refresh()

    s._pipeline._set_tool_stage_permission_matrix.assert_called_once_with(
        permission_rules=fake_rules,
        permission_mode=fake_mode,
    )
    s._pipeline._set_tool_stage_hook_runner.assert_not_called()


def test_apply_with_scope_all_calls_both_setters(monkeypatch) -> None:
    s = _bare_session()
    s.queue_runtime_refresh("all")

    import service.permission.install as perm_install
    import service.hooks.install as hook_install

    monkeypatch.setattr(
        perm_install, "install_permission_rules", lambda: ([], "advisory"),
    )
    monkeypatch.setattr(
        hook_install, "install_hook_runner", lambda: object(),
    )

    s._apply_pending_runtime_refresh()
    s._pipeline._set_tool_stage_permission_matrix.assert_called_once()
    s._pipeline._set_tool_stage_hook_runner.assert_called_once()


def test_apply_skips_hook_when_install_returns_none(monkeypatch) -> None:
    """install_hook_runner returns ``None`` when the env gate is closed
    or no hooks are configured — refresh must skip the setter quietly."""
    s = _bare_session()
    s.queue_runtime_refresh("hooks")

    import service.hooks.install as hook_install

    monkeypatch.setattr(hook_install, "install_hook_runner", lambda: None)

    s._apply_pending_runtime_refresh()
    s._pipeline._set_tool_stage_hook_runner.assert_not_called()


# ── O.1 (cycle 20260426_3) — extended scopes ────────────────────


def _stage(name: str, slot_strategy=None, slot_name="retriever"):
    """Build a fake stage with one strategy slot."""
    slot = SimpleNamespace(strategy=slot_strategy)
    return SimpleNamespace(
        name=name,
        get_strategy_slots=lambda: {slot_name: slot},
    )


def _pipeline_with_stages(stages):
    """Wrap stages in a fake pipeline whose ``_stages.values()`` returns them."""
    p = SimpleNamespace(
        _set_tool_stage_permission_matrix=MagicMock(),
        _set_tool_stage_hook_runner=MagicMock(),
        _stages=SimpleNamespace(values=lambda: stages),
    )
    return p


def test_memory_tuning_scope_accepted() -> None:
    s = _bare_session()
    assert s.queue_runtime_refresh("memory_tuning") is True
    assert s._pending_runtime_refresh == "memory_tuning"


def test_affect_scope_accepted() -> None:
    s = _bare_session()
    assert s.queue_runtime_refresh("affect") is True
    assert s._pending_runtime_refresh == "affect"


def test_memory_tuning_apply_mutates_retriever_attrs(monkeypatch) -> None:
    """memory_tuning scope re-reads load_memory_tuning + mutates the
    GenyMemoryRetriever instance attrs in place (Stage 2 context.retriever)."""
    s = _bare_session()
    retriever = SimpleNamespace(
        _max_inject=10,
        _recent_turns=2,
        _enable_vector=False,
    )
    s._pipeline = _pipeline_with_stages([
        _stage("context", slot_strategy=retriever, slot_name="retriever"),
    ])
    s._role = "worker"

    import service.memory_provider.config as mem_cfg

    monkeypatch.setattr(
        mem_cfg, "load_memory_tuning",
        lambda *, is_vtuber: {
            "max_inject_chars": 30000,
            "recent_turns": 12,
            "enable_vector_search": True,
            "enable_reflection": True,
        },
    )

    s.queue_runtime_refresh("memory_tuning")
    s._apply_pending_runtime_refresh()

    assert retriever._max_inject == 30000
    assert retriever._recent_turns == 12
    assert retriever._enable_vector is True


def test_memory_tuning_apply_mutates_strategy_attr(monkeypatch) -> None:
    """memory_tuning scope also touches Stage 18 memory.strategy
    (enable_reflection)."""
    s = _bare_session()
    strategy = SimpleNamespace(_enable_reflection=False)
    s._pipeline = _pipeline_with_stages([
        _stage("memory", slot_strategy=strategy, slot_name="strategy"),
    ])
    s._role = "worker"

    import service.memory_provider.config as mem_cfg

    monkeypatch.setattr(
        mem_cfg, "load_memory_tuning",
        lambda *, is_vtuber: {
            "max_inject_chars": 10000,
            "recent_turns": 6,
            "enable_vector_search": True,
            "enable_reflection": True,
        },
    )

    s.queue_runtime_refresh("memory_tuning")
    s._apply_pending_runtime_refresh()

    assert strategy._enable_reflection is True


def test_affect_apply_mutates_emitter(monkeypatch) -> None:
    """affect scope finds the AffectTagEmitter on Stage 17 and updates
    its _max_tags_per_turn."""
    s = _bare_session()
    emitter = SimpleNamespace(name="affect_tag", _max_tags_per_turn=1)
    chain = SimpleNamespace(items=[emitter])
    emit_stage = SimpleNamespace(
        name="emit",
        emitters=chain,
        get_strategy_slots=lambda: {},
    )
    s._pipeline = _pipeline_with_stages([emit_stage])

    import service.emit.chain_install as ci

    monkeypatch.setattr(ci, "_resolve_max_tags", lambda _default: 7)

    s.queue_runtime_refresh("affect")
    s._apply_pending_runtime_refresh()

    assert emitter._max_tags_per_turn == 7


def test_affect_apply_no_emitter_is_silent(monkeypatch) -> None:
    """If the chain has no AffectTagEmitter (manifest dropped it), the
    refresh quietly does nothing."""
    s = _bare_session()
    chain = SimpleNamespace(items=[])
    emit_stage = SimpleNamespace(
        name="emit",
        emitters=chain,
        get_strategy_slots=lambda: {},
    )
    s._pipeline = _pipeline_with_stages([emit_stage])

    import service.emit.chain_install as ci

    monkeypatch.setattr(ci, "_resolve_max_tags", lambda _default: 7)

    s.queue_runtime_refresh("affect")
    # Must not raise.
    s._apply_pending_runtime_refresh()


def test_all_scope_includes_new_branches(monkeypatch) -> None:
    """``all`` must touch the new memory/affect branches alongside the
    permissions/hooks ones."""
    s = _bare_session()
    retriever = SimpleNamespace(
        _max_inject=1, _recent_turns=1, _enable_vector=False,
    )
    emitter = SimpleNamespace(name="affect_tag", _max_tags_per_turn=1)
    s._pipeline = _pipeline_with_stages([
        _stage("context", slot_strategy=retriever, slot_name="retriever"),
        SimpleNamespace(
            name="emit",
            emitters=SimpleNamespace(items=[emitter]),
            get_strategy_slots=lambda: {},
        ),
    ])
    # Add the existing setter MagicMocks so the permissions/hooks
    # branches don't fail.
    s._pipeline._set_tool_stage_permission_matrix = MagicMock()
    s._pipeline._set_tool_stage_hook_runner = MagicMock()
    s._role = "worker"

    import service.memory_provider.config as mem_cfg
    import service.emit.chain_install as ci
    import service.permission.install as perm_install
    import service.hooks.install as hook_install

    monkeypatch.setattr(
        mem_cfg, "load_memory_tuning",
        lambda *, is_vtuber: {
            "max_inject_chars": 99999,
            "recent_turns": 99,
            "enable_vector_search": True,
            "enable_reflection": True,
        },
    )
    monkeypatch.setattr(ci, "_resolve_max_tags", lambda _default: 42)
    monkeypatch.setattr(perm_install, "install_permission_rules", lambda: ([], "advisory"))
    monkeypatch.setattr(hook_install, "install_hook_runner", lambda: object())

    s.queue_runtime_refresh("all")
    s._apply_pending_runtime_refresh()

    # Memory + affect both updated.
    assert retriever._max_inject == 99999
    assert emitter._max_tags_per_turn == 42
    # Permissions + hooks setters fired.
    s._pipeline._set_tool_stage_permission_matrix.assert_called_once()
    s._pipeline._set_tool_stage_hook_runner.assert_called_once()
