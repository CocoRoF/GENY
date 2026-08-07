"""Regression tests for the memory-model routing wiring.

After ``AgentSession._build_pipeline`` runs:

* Stages 2 (``s02_context``) and 18 (``s18_memory``) carry a
  :class:`ModelConfig` override whose ``model`` matches
  ``APIConfig.memory_model`` (or ``anthropic_model`` when empty).
* ``state.llm_client`` is a :class:`BaseClient` built via
  :meth:`ClientRegistry.get(provider)`.
* :class:`GenyMemoryStrategy` receives a non-None resolver and, by
  default, ``llm_reflect=None`` (the native path). The legacy flag
  re-installs the callback.
* Stages 2/18 missing from the manifest emit a warning but do not
  raise — the session still boots.

History: cycle 20260421_4 introduced the wiring, but at that time
the pipeline had 18 stages and the memory stage lived at order 15.
The pipeline expanded to 21 stages (cycle 20260430_x), the memory
stage moved to order 18, and the wiring was *not* updated until
cycle 20260501_1 A1. These tests now reflect the corrected target;
without A1 the prior test file referenced order 15 (HITL) and the
real memory stage was silently un-wired.
"""

from __future__ import annotations

from typing import Dict, List
from unittest.mock import MagicMock

import pytest

from service.sessions.models import SessionRole
from service.executor.agent_session import AgentSession


# ─────────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────────


class _StubStage:
    """Minimal Stage double exposing the surface ``_build_pipeline`` touches.

    Mirrors the real :class:`geny_executor.core.stage.Stage` attribute
    shape: the mutator assigns ``stage.model_override = cfg`` (property
    setter), and the resolver reads ``_model_override`` at reflect time.
    """

    def __init__(self, order: int, name: str):
        self.order = order
        self.name = name
        self._model_override = None
        self._config: Dict[str, object] = {}

    @property
    def model_override(self):
        return self._model_override

    @model_override.setter
    def model_override(self, value) -> None:
        self._model_override = value

    def resolve_model_config(self, state):
        return self._model_override

    def update_config(self, cfg: Dict[str, object]) -> None:
        self._config.update(cfg)


class _StubPipeline:
    """Stand-in for the manifest-built Pipeline.

    Only exposes the two surfaces ``_build_pipeline`` actually reaches
    on the prebuilt_pipeline: ``.stages`` (list of Stage-like objects
    the mutator walks) and ``.attach_runtime`` (collecting kwargs for
    inspection).
    """

    def __init__(self, stages: List[_StubStage]):
        self.stages = stages
        self.attach_calls: List[dict] = []

    def get_stage(self, order: int):
        for st in self.stages:
            if st.order == order:
                return st
        return None

    def attach_runtime(self, **kwargs) -> None:
        self.attach_calls.append(kwargs)


@pytest.fixture
def stub_full_pipeline():
    return _StubPipeline([
        _StubStage(2, "context"),
        _StubStage(6, "api"),
        _StubStage(15, "hitl"),     # cycle 20260501_1 A1 — HITL is at 15;
                                    # the wiring must NOT target this
                                    # stage as memory.
        _StubStage(18, "memory"),   # the real memory stage
    ])


@pytest.fixture
def stub_minimal_pipeline():
    """Pipeline with only s06 — no memory-related stages."""
    return _StubPipeline([_StubStage(6, "api")])


def _make_session(pipeline: _StubPipeline) -> AgentSession:
    session = AgentSession(
        session_id="s-test",
        session_name="T",
        role=SessionRole.WORKER,
        prebuilt_pipeline=pipeline,
    )
    session._env_id = "env-test"
    session._memory_manager = MagicMock()
    session._storage_path = "/tmp/test-session"
    session._working_dir = "/tmp/test-session"
    return session


def _clear_cycle4_env(monkeypatch, tmp_path) -> None:
    """Unset cycle-4 env vars AND reset the config_manager singleton.

    ``get_config_manager`` is a process-global singleton that caches
    loaded configs, and the fallback JSON file persists across tests.
    Without both resets, earlier tests' env-var-driven defaults leak
    into later tests.
    """
    for var in ("MEMORY_MODEL", "ANTHROPIC_MODEL", "LLM_PROVIDER",
                "LLM_BASE_URL", "USE_LEGACY_REFLECT"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

    from service.config import manager as mgr_mod
    monkeypatch.setattr(mgr_mod, "_config_manager", None)
    # Point the fresh manager at an isolated tmp dir so tests don't
    # collide with the dev environment's on-disk api.json.
    original_ctor = mgr_mod.ConfigManager.__init__

    def _tmp_ctor(self, config_dir=None, app_db=None):
        original_ctor(self, config_dir=tmp_path, app_db=app_db)

    monkeypatch.setattr(mgr_mod.ConfigManager, "__init__", _tmp_ctor)


# ─────────────────────────────────────────────────────────────────
# Stage overrides
# ─────────────────────────────────────────────────────────────────


def test_stage_overrides_use_memory_model(stub_full_pipeline, monkeypatch, tmp_path):
    _clear_cycle4_env(monkeypatch, tmp_path)
    monkeypatch.setenv("MEMORY_MODEL", "claude-haiku-4-5-20251001")

    session = _make_session(stub_full_pipeline)
    session._build_pipeline()

    s2, _s6, s15, s18 = stub_full_pipeline.stages
    assert s2._model_override is not None
    assert s2._model_override.model == "claude-haiku-4-5-20251001"
    # Cycle 20260501_1 A1 — memory_cfg goes to s18, NOT s15.
    assert s18._model_override is not None
    assert s18._model_override.model == "claude-haiku-4-5-20251001"
    assert s15._model_override is None, (
        "HITL stage must not receive memory_model — that was the "
        "pre-cycle bug A1 fixed."
    )


def test_empty_memory_model_falls_back_to_main(stub_full_pipeline, monkeypatch, tmp_path):
    _clear_cycle4_env(monkeypatch, tmp_path)
    monkeypatch.setenv("MEMORY_MODEL", "")
    monkeypatch.setenv("ANTHROPIC_MODEL", "claude-sonnet-4-6")

    session = _make_session(stub_full_pipeline)
    session._build_pipeline()

    s2, _s6, _s15, s18 = stub_full_pipeline.stages
    assert s2._model_override.model == "claude-sonnet-4-6"
    assert s18._model_override.model == "claude-sonnet-4-6"


# ─────────────────────────────────────────────────────────────────
# attach_runtime(llm_client=…)
# ─────────────────────────────────────────────────────────────────


def test_attach_runtime_does_not_inject_llm_client(stub_full_pipeline, monkeypatch, tmp_path):
    """Regression for the 401 loop fixed by PR #866 + the source-of-truth
    refactor: passing the Anthropic SDK fallback client to
    ``attach_runtime(llm_client=...)`` pre-empted the manifest's Stage-6
    provider in ``Pipeline._resolve_llm_client`` (attach-time client wins
    over manifest). Geny now keeps the Anthropic SDK handle on
    ``self._llm_client_handle`` for out-of-pipeline tools only; the
    pipeline state resolves its client strictly from the manifest's
    Stage-6 provider + the CredentialBundle."""
    _clear_cycle4_env(monkeypatch, tmp_path)
    session = _make_session(stub_full_pipeline)
    session._build_pipeline()

    captured = stub_full_pipeline.attach_calls[-1]
    assert "llm_client" not in captured, (
        "attach_runtime must not receive llm_client — that bypassed the "
        "manifest provider and routed every session through Anthropic."
    )


# Phase H — provider selection moved to per-Environment manifest. The
# session no longer reads a global provider, so the "unknown provider
# surfaces at build time" and "s06 stage config synced from APIConfig"
# tests were removed. s06's provider / base_url now come from the
# manifest at instantiation time; AgentSession does not override them.


# ─────────────────────────────────────────────────────────────────
# Reflection wiring
# ─────────────────────────────────────────────────────────────────


# NOTE — three tests were removed here. They asserted that the memory
# strategy carries a reflection resolver (`_resolver`) and, by default, no
# LLM callback (`_llm_reflect`), with a legacy flag to restore it.
#
# The executor SDK's ProviderDrivenStrategy has neither attribute, and
# GenyDedupeStrategy — which subclasses it — takes only a provider. Reflection
# routing left with it. The `enable_reflection` setting is affected the same
# way: AgentSession sets it behind `hasattr(strategy, "_enable_reflection")`,
# which is now always False, so the toggle is inert.
#
# Model routing for stages 2 and 18 is unaffected and is still covered above.


def test_missing_memory_stages_is_warning_not_failure(
    stub_minimal_pipeline, monkeypatch, tmp_path, caplog
):
    _clear_cycle4_env(monkeypatch, tmp_path)

    session = _make_session(stub_minimal_pipeline)
    with caplog.at_level("WARNING"):
        session._build_pipeline()  # must not raise

    captured = stub_minimal_pipeline.attach_calls[-1]
    # Build succeeded — attach_runtime received the system_builder /
    # tool_context bundle. llm_client is intentionally absent (see
    # ``test_attach_runtime_does_not_inject_llm_client``).
    assert "system_builder" in captured
    joined = " ".join(rec.message for rec in caplog.records)
    assert "memory wiring: s02 context stage absent" in joined
    assert "memory wiring: s18 memory stage absent" in joined
