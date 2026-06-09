"""Coverage for ``LLMCredentialsConfig.default_provider`` global override.

The override pins a single Stage-6 provider for every session — used so the
operator can switch the whole app to ``claude_code_cli`` (OAuth Pro/Max
subscription) without editing each env manifest. The validator on session
create and the actual pipeline-build path must agree on what the override
resolves to, otherwise the validator either over-rejects (session refused
with "credentials missing" even though the override would have steered to a
backend with valid credentials) or under-rejects (session accepted then
crashes mid-stream when the bundle has no entry for the resolved provider).

The four invariants asserted here:

1. ``CredentialBundleBuilder.build()`` includes ``claude_code_cli`` when
   ``default_provider="claude_code_cli"`` even if ``CLIBackendClaudeCodeConfig.enabled``
   is False.
2. ``EnvironmentService._apply_default_provider_override`` rewrites Stage-6's
   ``config['provider']`` to the override.
3. The rewrite is in-memory only — the manifest file on disk is untouched
   (the boot-time template re-seed must remain the source of truth for the
   env's own provider choice; flipping the override back to empty restores
   the env's original provider on the next session).
4. Empty ``default_provider`` is a no-op.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict
from unittest.mock import patch

import pytest

from service.config.sub_config.general.cli_backends_config import (
    CLIBackendClaudeCodeConfig,
)
from service.config.sub_config.general.llm_credentials_config import (
    LLMCredentialsConfig,
)
from service.environment.service import EnvironmentService
from service.executor.credentials import CredentialBundleBuilder


def _minimal_env_manifest_dict(provider: str = "anthropic") -> Dict[str, Any]:
    """Hand-rolled v2 manifest with just Stage 6 wired — keeps the test
    decoupled from the template builder so a future template-shape change
    can't false-fail the override invariants."""
    return {
        "metadata": {
            "id": "test-env-default-provider",
            "name": "Test env",
            "description": "",
            "tags": [],
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z",
        },
        "pipeline": {"name": "test", "max_iterations": 1},
        "stages": [
            {
                "order": 6,
                "name": "api",
                "active": True,
                "artifact": "default",
                "strategies": {"retry": "exponential_backoff", "router": "passthrough"},
                "strategy_configs": {},
                "config": {"provider": provider},
                "tool_binding": None,
                "model_override": None,
                "chain_order": {},
            }
        ],
        "tools": {"built_in": [], "external": [], "mcp_servers": []},
    }


class _StubConfigManager:
    """Minimal ConfigManager stub returning the two configs the override
    paths actually read. Keeps tests off the live PostgreSQL store so they
    run in any sandbox."""

    def __init__(
        self,
        *,
        default_provider: str = "",
        cli_enabled: bool = False,
        anthropic_api_key: str = "",
    ) -> None:
        self._llm = LLMCredentialsConfig(
            anthropic_api_key=anthropic_api_key,
            default_provider=default_provider,
        )
        self._cli = CLIBackendClaudeCodeConfig(enabled=cli_enabled)

    def load_config(self, cls):
        if cls is LLMCredentialsConfig:
            return self._llm
        if cls is CLIBackendClaudeCodeConfig:
            return self._cli
        raise ValueError(f"unexpected config requested: {cls}")


# ─────────────────────────────────────────── bundle build ─


def test_bundle_includes_claude_code_cli_when_default_provider_set():
    """``default_provider="claude_code_cli"`` is sufficient to populate the
    bundle even if the operator never toggled the enable flag on the
    backends card. Without this, the validator at session-create time
    sees an empty bundle entry and rejects an otherwise serviceable
    session."""
    cm = _StubConfigManager(default_provider="claude_code_cli", cli_enabled=False)
    bundle = CredentialBundleBuilder(config_manager=cm).build()
    assert "claude_code_cli" in bundle.by_provider
    assert bundle.has("claude_code_cli")


def test_bundle_excludes_claude_code_cli_when_neither_enabled_nor_default():
    """Default behaviour: opt-in only. Without an explicit signal the
    bundle stays minimal so the validator surfaces "log in / paste a key"
    rather than wiring a never-used CLI client."""
    cm = _StubConfigManager(default_provider="", cli_enabled=False)
    bundle = CredentialBundleBuilder(config_manager=cm).build()
    assert "claude_code_cli" not in bundle.by_provider


def test_bundle_includes_claude_code_cli_when_only_enabled():
    """Pre-existing path — user toggles the card's enable switch
    without using the global default. Stays supported so the existing
    UX is not regressed."""
    cm = _StubConfigManager(default_provider="", cli_enabled=True)
    bundle = CredentialBundleBuilder(config_manager=cm).build()
    assert "claude_code_cli" in bundle.by_provider


# ─────────────────────────────────── manifest rewrite ─


def test_apply_default_provider_override_rewrites_stage6(tmp_path):
    svc = EnvironmentService(storage_path=str(tmp_path / "envs"))
    env_path = svc.storage_path / "test-env-default-provider.json"
    env_path.write_text(
        json.dumps(
            {
                "id": "test-env-default-provider",
                "name": "Test env",
                "manifest": _minimal_env_manifest_dict(provider="anthropic"),
            }
        )
    )
    manifest = svc.load_manifest("test-env-default-provider")
    assert manifest is not None
    # Sanity: Stage 6 starts on anthropic.
    s6 = next(e for e in manifest.stage_entries() if e.order == 6)
    assert (s6.config or {}).get("provider") == "anthropic"

    with patch(
        "service.config.get_config_manager",
        return_value=_StubConfigManager(default_provider="claude_code_cli"),
    ):
        svc._apply_default_provider_override(manifest)

    s6 = next(e for e in manifest.stage_entries() if e.order == 6)
    assert (s6.config or {}).get("provider") == "claude_code_cli"


def test_apply_default_provider_override_is_in_memory_only(tmp_path):
    """The on-disk manifest must not be touched — the boot template
    re-seed is the canonical source for the env's own provider, and
    persisting the rewrite would silently fight with it on the next
    boot."""
    svc = EnvironmentService(storage_path=str(tmp_path / "envs"))
    env_path = svc.storage_path / "test-env-default-provider.json"
    env_path.write_text(
        json.dumps(
            {
                "id": "test-env-default-provider",
                "name": "Test env",
                "manifest": _minimal_env_manifest_dict(provider="anthropic"),
            }
        )
    )
    manifest = svc.load_manifest("test-env-default-provider")
    with patch(
        "service.config.get_config_manager",
        return_value=_StubConfigManager(default_provider="claude_code_cli"),
    ):
        svc._apply_default_provider_override(manifest)

    reread = json.loads(env_path.read_text())
    s6 = next(s for s in reread["manifest"]["stages"] if s["name"] == "api")
    assert s6["config"]["provider"] == "anthropic"


def test_apply_default_provider_override_empty_is_noop(tmp_path):
    svc = EnvironmentService(storage_path=str(tmp_path / "envs"))
    env_path = svc.storage_path / "test-env-default-provider.json"
    env_path.write_text(
        json.dumps(
            {
                "id": "test-env-default-provider",
                "name": "Test env",
                "manifest": _minimal_env_manifest_dict(provider="anthropic"),
            }
        )
    )
    manifest = svc.load_manifest("test-env-default-provider")
    with patch(
        "service.config.get_config_manager",
        return_value=_StubConfigManager(default_provider=""),
    ):
        svc._apply_default_provider_override(manifest)

    s6 = next(e for e in manifest.stage_entries() if e.order == 6)
    assert (s6.config or {}).get("provider") == "anthropic"


# ─────────────────────────────────── primary-provider validator ─


def test_extract_primary_provider_returns_default_when_set():
    """The session-create validator must agree with what
    ``instantiate_pipeline`` will actually wire — otherwise it rejects
    sessions that would have worked fine."""
    from service.executor.agent_session_manager import AgentSessionManager

    mgr = AgentSessionManager.__new__(AgentSessionManager)
    mgr._environment_service = None  # validator returns override before reading env

    with patch(
        "service.config.get_config_manager",
        return_value=_StubConfigManager(default_provider="claude_code_cli"),
    ):
        assert mgr._extract_primary_provider("anything") == "claude_code_cli"


def test_extract_primary_provider_falls_back_to_env_when_no_default(tmp_path):
    from service.executor.agent_session_manager import AgentSessionManager

    svc = EnvironmentService(storage_path=str(tmp_path / "envs"))
    env_path = svc.storage_path / "test-env-default-provider.json"
    env_path.write_text(
        json.dumps(
            {
                "id": "test-env-default-provider",
                "name": "Test env",
                "manifest": _minimal_env_manifest_dict(provider="openai"),
            }
        )
    )

    mgr = AgentSessionManager.__new__(AgentSessionManager)
    mgr._environment_service = svc

    with patch(
        "service.config.get_config_manager",
        return_value=_StubConfigManager(default_provider=""),
    ):
        assert mgr._extract_primary_provider("test-env-default-provider") == "openai"
