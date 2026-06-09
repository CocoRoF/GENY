"""Coverage for the "Environment manifest = single source of truth" refactor.

This replaces ``test_default_provider_override.py`` from the prior
heuristics era. The old override layer (PR #861) and several bypass
paths have been removed; what's tested here is that the canonical flow
holds end-to-end.

Invariants:

1. ``CredentialBundleBuilder.build()`` includes ``claude_code_cli`` iff
   ``CLIBackendClaudeCodeConfig.enabled`` is True. No second source.
2. ``_build_claude_code`` only plumbs an API key into the subprocess
   env when ``auth_mode == 'api_key'`` (subscription / host-mount /
   setup-token modes leave ``ANTHROPIC_API_KEY`` unset so the CLI uses
   its own credential file).
3. ``AgentSessionManager._extract_primary_provider`` returns whatever
   the env manifest's ``stage6.config['provider']`` says — no global
   override layer in front of it.
4. ``pick_default_backend_provider`` reads the user's configured
   backend and returns it, falling back conservatively.
"""

from __future__ import annotations

import json
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
from service.executor.backend_resolver import pick_default_backend_provider
from service.executor.credentials import CredentialBundleBuilder


def _minimal_env_manifest_dict(provider: str = "anthropic") -> Dict[str, Any]:
    return {
        "metadata": {
            "id": "test-env",
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
    def __init__(
        self,
        *,
        cli_enabled: bool = False,
        anthropic_api_key: str = "",
        openai_api_key: str = "",
        google_api_key: str = "",
        base_url: str = "",
        cli_auth_mode: str = "host_mount",
        cli_api_key: str = "",
    ) -> None:
        self._llm = LLMCredentialsConfig(
            anthropic_api_key=anthropic_api_key,
            openai_api_key=openai_api_key,
            google_api_key=google_api_key,
            base_url=base_url,
        )
        self._cli = CLIBackendClaudeCodeConfig(
            enabled=cli_enabled,
            auth_mode=cli_auth_mode,
            api_key=cli_api_key,
        )

    def load_config(self, cls):
        if cls is LLMCredentialsConfig:
            return self._llm
        if cls is CLIBackendClaudeCodeConfig:
            return self._cli
        raise ValueError(f"unexpected config requested: {cls}")


# ─────────────────────────────────── bundle ─


def test_bundle_includes_claude_code_cli_when_enabled():
    cm = _StubConfigManager(cli_enabled=True)
    bundle = CredentialBundleBuilder(config_manager=cm).build()
    assert "claude_code_cli" in bundle.by_provider


def test_bundle_excludes_claude_code_cli_when_disabled():
    cm = _StubConfigManager(cli_enabled=False, anthropic_api_key="sk-ant-x")
    bundle = CredentialBundleBuilder(config_manager=cm).build()
    assert "claude_code_cli" not in bundle.by_provider, (
        "claude_code_cli should not appear in the bundle just because an "
        "Anthropic key is present elsewhere — that was the default_provider "
        "bypass which has been removed."
    )


def test_bundle_no_api_key_for_subscription_modes():
    """Three subscription-style modes (host_mount / in_modal_login /
    setup_token) must NOT plumb ANTHROPIC_API_KEY into the subprocess —
    Claude Code prefers env-var auth over its own OAuth file."""
    for mode in ("host_mount", "in_modal_login", "setup_token"):
        cm = _StubConfigManager(
            cli_enabled=True,
            cli_auth_mode=mode,
            cli_api_key="sk-ant-ignored-in-subscription-modes",
            anthropic_api_key="sk-ant-also-ignored",
        )
        bundle = CredentialBundleBuilder(config_manager=cm).build()
        cc = bundle.get("claude_code_cli")
        assert cc.api_key == "", f"mode={mode}: leaked {cc.api_key!r}"


def test_bundle_passes_api_key_only_in_api_key_mode():
    cm = _StubConfigManager(
        cli_enabled=True,
        cli_auth_mode="api_key",
        cli_api_key="sk-ant-explicit",
    )
    bundle = CredentialBundleBuilder(config_manager=cm).build()
    assert bundle.get("claude_code_cli").api_key == "sk-ant-explicit"


# ─────────────────────────────────── primary provider extraction ─


def test_extract_primary_provider_reads_manifest_only(tmp_path):
    """No global override layer in front of the manifest. The validator
    sees exactly what Pipeline.from_manifest_async will wire."""
    from service.executor.agent_session_manager import AgentSessionManager

    svc = EnvironmentService(storage_path=str(tmp_path / "envs"))
    (svc.storage_path / "test-env.json").write_text(
        json.dumps({
            "id": "test-env",
            "name": "Test",
            "manifest": _minimal_env_manifest_dict(provider="claude_code_cli"),
        })
    )

    mgr = AgentSessionManager.__new__(AgentSessionManager)
    mgr._environment_service = svc
    assert mgr._extract_primary_provider("test-env") == "claude_code_cli"


# ─────────────────────────────────── backend_resolver ─


def test_resolver_picks_cli_when_enabled():
    cm = _StubConfigManager(cli_enabled=True, anthropic_api_key="sk-ant-x")
    assert pick_default_backend_provider(cm) == "claude_code_cli"


def test_resolver_picks_anthropic_when_only_anthropic_key():
    cm = _StubConfigManager(cli_enabled=False, anthropic_api_key="sk-ant-x")
    assert pick_default_backend_provider(cm) == "anthropic"


def test_resolver_picks_openai_when_only_openai_key():
    cm = _StubConfigManager(cli_enabled=False, openai_api_key="sk-proj-x")
    assert pick_default_backend_provider(cm) == "openai"


def test_resolver_falls_back_to_anthropic_when_nothing_configured():
    cm = _StubConfigManager()
    assert pick_default_backend_provider(cm) == "anthropic"


# ─────────────────────────────────── default_manifest provider plumbing ─


def test_build_default_manifest_threads_provider():
    """Phase 1 of the refactor: ``build_default_manifest`` now accepts a
    provider arg so the boot-time template installer can stamp the
    user's active backend into Stage 6 directly."""
    from service.executor.default_manifest import build_default_manifest

    m = build_default_manifest(preset="vtuber", provider="claude_code_cli")
    s6 = next(s for s in m.stages if s["name"] == "api")
    assert s6["config"]["provider"] == "claude_code_cli"


def test_build_default_manifest_defaults_to_anthropic():
    """Backward-compat: callers that don't pass a provider still get
    a working manifest (anthropic) — same behaviour as before the
    refactor for any test fixture or script that hasn't migrated."""
    from service.executor.default_manifest import build_default_manifest

    m = build_default_manifest(preset="vtuber")
    s6 = next(s for s in m.stages if s["name"] == "api")
    assert s6["config"]["provider"] == "anthropic"
