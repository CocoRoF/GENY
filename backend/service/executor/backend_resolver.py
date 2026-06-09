"""Single source of truth for "which LLM backend should we default to?"

Geny is a consumer of geny-executor's Environment / manifest system. The
canonical choice for which backend a session uses lives in the env's
``stages[6].config['provider']`` — set by the user (or by the template
builder when a new env is created). This module exists for the *very
narrow* set of places that need to pick a backend BEFORE a manifest
exists:

  * ``install_environment_templates`` at boot — the template envs need a
    Stage-6 provider value baked in, and the user's signal of choice is
    whichever backend they have configured credentials / login for.
  * ``service.memory.memory_llm`` — background memory curation runs
    outside any session and so has no manifest to consult.
  * Sub-agent factory fallback when the parent session's
    ``primary_provider`` is unknown (sub-agents normally inherit, but
    Geny still needs a non-crashing default for the very first session
    after boot, before any real ``primary_provider`` exists).

Resolution order:

  1. ``CLIBackendClaudeCodeConfig.enabled`` is True → ``"claude_code_cli"``
     (matches the user's modal choice: any of host_mount / in_modal_login
     / setup_token / api_key — they all run through the CLI).
  2. ``LLMCredentialsConfig.anthropic_api_key`` is set → ``"anthropic"``.
  3. OpenAI / Google / vLLM in declaration order.
  4. ``"anthropic"`` as the absolute fallback so the executor's
     ``ClientRegistry`` lookup never raises during install_templates.

We deliberately do NOT consult ``LLMCredentialsConfig.default_provider``
here — that field was the "global override" bypass layer (PR #861)
which is being removed in this same refactor. Backends are derived
from what the user actually configured, not from a separate setting.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)


__all__ = ["pick_default_backend_provider"]


def pick_default_backend_provider(config_manager: Optional[Any] = None) -> str:
    """Return the provider name to use when no manifest is available.

    Args:
        config_manager: optional ConfigManager. When ``None`` the global
            singleton is used. Tests inject a stub here.

    Returns:
        One of ``"claude_code_cli"`` / ``"anthropic"`` / ``"openai"`` /
        ``"google"`` / ``"vllm"``. Never raises — a misconfigured backend
        still yields the conservative ``"anthropic"`` fallback so caller
        code stays one branch shorter.
    """
    try:
        if config_manager is None:
            from service.config import get_config_manager
            config_manager = get_config_manager()
        from service.config.sub_config.general.cli_backends_config import (
            CLIBackendClaudeCodeConfig,
        )
        from service.config.sub_config.general.llm_credentials_config import (
            LLMCredentialsConfig,
        )
        cli = config_manager.load_config(CLIBackendClaudeCodeConfig)
        creds = config_manager.load_config(LLMCredentialsConfig)
    except Exception:  # noqa: BLE001 — defensive, very early-boot callers
        logger.debug("backend_resolver: config unavailable, defaulting to anthropic", exc_info=True)
        return "anthropic"

    if getattr(cli, "enabled", False):
        return "claude_code_cli"
    if getattr(creds, "anthropic_api_key", ""):
        return "anthropic"
    if getattr(creds, "openai_api_key", ""):
        return "openai"
    if getattr(creds, "google_api_key", ""):
        return "google"
    if getattr(creds, "base_url", ""):
        return "vllm"
    return "anthropic"
