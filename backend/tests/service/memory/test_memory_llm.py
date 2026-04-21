"""Regression tests for the cycle 20260421_5 memory-LLM adapter.

After this cycle:

* ``build_memory_llm`` returns ``None`` when no API key is configured,
  so ``CurationEngine`` degrades cleanly without raising.
* Empty ``APIConfig.memory_model`` falls back to ``anthropic_model`` —
  the same contract used by ``AgentSession._build_pipeline`` so
  operators don't have to reason about two different fallback rules
  depending on whether the call happens in-session or in curation.
* ``APIConfig.provider`` and ``APIConfig.base_url`` flow through to
  the underlying ``BaseClient`` — a user who switches provider to
  ``openai`` or ``vllm`` gets curation on that provider, not
  silently on Anthropic.
* ``MemoryLLM.complete`` wraps a ``BaseClient.create_message`` call
  with the ``ModelConfig`` built from the above; the return value
  is the joined text content so duck-typed callers (currently just
  ``CurationEngine``) don't have to know ``APIResponse``'s shape.

These tests pin the migration done in cycle 20260421_5 so a later
refactor can't silently regress curation back onto the hardcoded
ChatAnthropic path removed by this cycle.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from service.memory.memory_llm import MemoryLLM, build_memory_llm


# ─────────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────────


def _reset_config_manager(monkeypatch, tmp_path) -> None:
    """Redirect the config-manager singleton at a fresh tmp dir.

    ``get_config_manager`` is a process-global singleton with a cache
    and an on-disk JSON fallback. Without this reset, env-var changes
    made inside one test leak into the next.
    """
    for var in (
        "MEMORY_MODEL",
        "ANTHROPIC_MODEL",
        "LLM_PROVIDER",
        "LLM_BASE_URL",
        "ANTHROPIC_API_KEY",
    ):
        monkeypatch.delenv(var, raising=False)

    from service.config import manager as mgr_mod

    monkeypatch.setattr(mgr_mod, "_config_manager", None)
    original_ctor = mgr_mod.ConfigManager.__init__

    def _tmp_ctor(self, config_dir=None, app_db=None):
        original_ctor(self, config_dir=tmp_path, app_db=app_db)

    monkeypatch.setattr(mgr_mod.ConfigManager, "__init__", _tmp_ctor)


# ─────────────────────────────────────────────────────────────────
# build_memory_llm
# ─────────────────────────────────────────────────────────────────


def test_build_memory_llm_returns_none_without_api_key(monkeypatch, tmp_path):
    _reset_config_manager(monkeypatch, tmp_path)
    # No ANTHROPIC_API_KEY → adapter cannot be built.
    assert build_memory_llm() is None


def test_build_memory_llm_uses_memory_model_when_set(monkeypatch, tmp_path):
    _reset_config_manager(monkeypatch, tmp_path)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("MEMORY_MODEL", "claude-haiku-4-5-20251001")

    llm = build_memory_llm()
    assert llm is not None
    assert llm.model_config.model == "claude-haiku-4-5-20251001"
    assert llm.model_config.max_tokens == 2048
    assert llm.model_config.temperature == 0.0
    assert llm.model_config.thinking_enabled is False


def test_build_memory_llm_falls_back_to_main_model_when_memory_empty(
    monkeypatch, tmp_path
):
    _reset_config_manager(monkeypatch, tmp_path)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("MEMORY_MODEL", "")
    monkeypatch.setenv("ANTHROPIC_MODEL", "claude-sonnet-4-6")

    llm = build_memory_llm()
    assert llm is not None
    assert llm.model_config.model == "claude-sonnet-4-6"


def test_build_memory_llm_uses_provider_selection(monkeypatch, tmp_path):
    _reset_config_manager(monkeypatch, tmp_path)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")

    llm = build_memory_llm()
    assert llm is not None
    assert llm.client.provider == "anthropic"


def test_build_memory_llm_passes_base_url(monkeypatch, tmp_path):
    _reset_config_manager(monkeypatch, tmp_path)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    monkeypatch.setenv("LLM_BASE_URL", "https://custom.example")

    llm = build_memory_llm()
    assert llm is not None
    # BaseClient stores base_url on _base_url during __init__.
    assert getattr(llm.client, "_base_url", None) == "https://custom.example"


def test_build_memory_llm_unknown_provider_returns_none(monkeypatch, tmp_path):
    _reset_config_manager(monkeypatch, tmp_path)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("LLM_PROVIDER", "not-a-real-provider")

    # Unknown provider must not crash the curation scheduler — the
    # helper swallows the registry error and returns None so callers
    # fall back to rule-based curation.
    assert build_memory_llm() is None


# ─────────────────────────────────────────────────────────────────
# MemoryLLM.complete
# ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_memory_llm_complete_returns_response_text():
    from geny_executor.core.config import ModelConfig
    from geny_executor.llm_client.types import APIResponse, ContentBlock

    fake_response = APIResponse(
        content=[ContentBlock(type="text", text="hello world")],
        stop_reason="end_turn",
    )
    fake_client = AsyncMock()
    fake_client.create_message = AsyncMock(return_value=fake_response)

    llm = MemoryLLM(
        client=fake_client,
        model_config=ModelConfig(
            model="claude-haiku-4-5-20251001",
            max_tokens=2048,
            temperature=0.0,
            thinking_enabled=False,
        ),
    )

    out = await llm.complete("test prompt", purpose="memory.curation.analyze")

    assert out == "hello world"
    fake_client.create_message.assert_awaited_once()
    call_kwargs = fake_client.create_message.await_args.kwargs
    assert call_kwargs["model_config"].model == "claude-haiku-4-5-20251001"
    assert call_kwargs["messages"] == [{"role": "user", "content": "test prompt"}]
    assert call_kwargs["purpose"] == "memory.curation.analyze"
