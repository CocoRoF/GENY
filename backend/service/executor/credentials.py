"""Build :class:`geny_executor.CredentialBundle` from Geny's settings.

Phase H of the LLM backend upgrade cycle. The API credentials moved
out of ``APIConfig`` into a dedicated hidden ``LLMCredentialsConfig``
(edited only through the LLM Backends panel); the CLI-backend configs
(``CLIBackendClaudeCodeConfig`` / ``CLIBackendCopilotConfig``) are also
hidden from the general list. This builder unifies all three into the
single :class:`CredentialBundle` channel that
``Pipeline.from_manifest_async`` consumes.

The bundle is built fresh per session so a user toggling a backend on
or off (or rotating a key) takes effect on the next session create.
"""

from __future__ import annotations

import os
import shutil
from typing import Any, Dict, Tuple

from geny_executor import CredentialBundle, ProviderCredentials

from service.config import get_config_manager
from service.config.sub_config.general.api_config import APIConfig
from service.config.sub_config.general.llm_credentials_config import LLMCredentialsConfig
from service.config.sub_config.general.cli_backends_config import (
    CLIBackendClaudeCodeConfig,
    CLIBackendCopilotConfig,
)


__all__ = ["CredentialBundleBuilder"]


def _split_csv(raw: str) -> Tuple[str, ...]:
    if not raw:
        return ()
    return tuple(s.strip() for s in raw.split(",") if s.strip())


class CredentialBundleBuilder:
    """Turn the live Geny config into a frozen :class:`CredentialBundle`.

    Usage::

        builder = CredentialBundleBuilder()
        bundle = builder.build()
        pipeline = await Pipeline.from_manifest_async(
            manifest, credentials=bundle, ...
        )

    The builder reads from ``get_config_manager()`` on every ``build()``
    call so it picks up live edits.
    """

    def __init__(self, config_manager: Any | None = None) -> None:
        self._cm = config_manager or get_config_manager()

    # ─────────────────────────────────────────────────────────── build ─

    def build(self) -> CredentialBundle:
        creds = self._cm.load_config(LLMCredentialsConfig)
        claude_cli = self._cm.load_config(CLIBackendClaudeCodeConfig)
        copilot_cli = self._cm.load_config(CLIBackendCopilotConfig)

        by_provider: Dict[str, ProviderCredentials] = {
            "anthropic": ProviderCredentials(
                api_key=(creds.anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY", "")),
            ),
            "openai": ProviderCredentials(
                api_key=(creds.openai_api_key or os.environ.get("OPENAI_API_KEY", "")),
            ),
            "google": ProviderCredentials(
                api_key=(creds.google_api_key or os.environ.get("GOOGLE_API_KEY", "")),
            ),
            "vllm": ProviderCredentials(
                base_url=(creds.base_url or None),
            ),
        }

        if claude_cli.enabled:
            by_provider["claude_code_cli"] = self._build_claude_code(creds, claude_cli)
        if copilot_cli.enabled:
            by_provider["copilot_cli"] = self._build_copilot(copilot_cli)

        return CredentialBundle(by_provider=by_provider)

    # ────────────────────────────────────────────────── claude_code_cli ─

    def _build_claude_code(
        self,
        creds: LLMCredentialsConfig,
        claude_cli: CLIBackendClaudeCodeConfig,
    ) -> ProviderCredentials:
        binary = (
            claude_cli.binary_path
            or os.environ.get("CLAUDE_CODE_BINARY", "")
            or (shutil.which("claude") or "")
        )
        api_key = (
            claude_cli.api_key
            or creds.anthropic_api_key
            or os.environ.get("ANTHROPIC_API_KEY", "")
        )
        extras: Dict[str, Any] = {
            "workspace_root": claude_cli.workspace_root or None,
            "bare_mode": bool(claude_cli.bare_mode),
            "default_permission_mode": claude_cli.default_permission_mode or "default",
            "allow_tools": _split_csv(claude_cli.allow_tools_csv),
            "disallow_tools": _split_csv(claude_cli.disallow_tools_csv),
            "extra_args": _split_csv(claude_cli.extra_args_csv),
            "timeout_s": float(claude_cli.timeout_s) if claude_cli.timeout_s else 300.0,
        }
        if claude_cli.max_budget_usd and claude_cli.max_budget_usd > 0:
            extras["max_budget_usd"] = float(claude_cli.max_budget_usd)
        if claude_cli.settings_path:
            extras["settings_path"] = claude_cli.settings_path
        if claude_cli.mcp_config_path:
            extras["mcp_config"] = claude_cli.mcp_config_path
        return ProviderCredentials(
            api_key=api_key,
            binary_path=binary,
            extras=extras,
        )

    # ───────────────────────────────────────────────────── copilot_cli ─

    def _build_copilot(self, copilot_cli: CLIBackendCopilotConfig) -> ProviderCredentials:
        binary = (
            copilot_cli.gh_binary_path
            or os.environ.get("GH_BINARY", "")
            or (shutil.which("gh") or "")
        )
        extras: Dict[str, Any] = {
            "allow_tools": _split_csv(copilot_cli.allow_tools_csv),
            "cwd": copilot_cli.cwd or None,
            "extra_args": _split_csv(copilot_cli.extra_args_csv),
            "timeout_s": float(copilot_cli.timeout_s) if copilot_cli.timeout_s else 180.0,
        }
        return ProviderCredentials(binary_path=binary, extras=extras)
