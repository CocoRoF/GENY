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

Phase I (``mcp_bridge=...``): when a session pins ``claude_code_cli``
as the Stage 6 provider, the builder synthesises a per-session MCP
config that wraps Geny's tool registry (via the
``backend/scripts/geny_mcp_bridge.py`` stdio bridge → HTTP endpoint).
The CLI's LLM then sees Geny tools as ``mcp__geny__<name>`` and the
``--strict-mcp-config`` + ``--tools ""`` flags emitted by executor
2.0.5 prevent it from hallucinating against CLI built-ins.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from geny_executor import CredentialBundle, ProviderCredentials

from service.config import get_config_manager
from service.config.sub_config.general.api_config import APIConfig
from service.config.sub_config.general.llm_credentials_config import LLMCredentialsConfig
from service.config.sub_config.general.cli_backends_config import (
    CLIBackendClaudeCodeConfig,
    CLIBackendCopilotConfig,
)


__all__ = ["CredentialBundleBuilder", "McpBridgeContext"]


def _split_csv(raw: str) -> Tuple[str, ...]:
    if not raw:
        return ()
    return tuple(s.strip() for s in raw.split(",") if s.strip())


class McpBridgeContext:
    """Per-session MCP bridge wiring info.

    Pass to :class:`CredentialBundleBuilder` to have it synthesize a
    ``mcp_config`` extras entry on the ``claude_code_cli`` provider
    that points the spawned CLI at the host's MCP bridge subprocess.
    The bridge proxies tool calls to
    ``POST /api/internal/mcp/{session_id}/rpc`` on the local Geny
    backend, authenticating via ``token`` (bearer).

    Attributes:
        session_id:  session UUID (used in the bridge URL path).
        token:       ephemeral bearer token (256-bit hex). Geny
                     validates it against the session's stored
                     ``_mcp_bridge_token``.
        base_url:    Geny backend base URL the bridge subprocess
                     should call back to. Defaults to
                     ``http://127.0.0.1:<APP_PORT>`` since the
                     bridge runs alongside Geny in the same
                     container.
    """

    def __init__(
        self,
        session_id: str,
        token: str,
        base_url: Optional[str] = None,
    ) -> None:
        self.session_id = session_id
        self.token = token
        self.base_url = base_url or _default_internal_base_url()


def _default_internal_base_url() -> str:
    port = os.environ.get("APP_PORT") or os.environ.get("BACKEND_PORT") or "8000"
    return f"http://127.0.0.1:{port}".rstrip("/")


# Path to the stdio bridge script. Computed once at import; the
# bridge file lives alongside this module under ``backend/scripts/``.
_BRIDGE_SCRIPT_PATH = (
    Path(__file__).resolve().parents[2] / "scripts" / "geny_mcp_bridge.py"
)


def _build_mcp_bridge_config(ctx: McpBridgeContext) -> Dict[str, Any]:
    """Synthesize the MCP config JSON the CLI's ``--mcp-config`` flag
    expects. Spawns ``geny_mcp_bridge.py`` as a stdio server, env
    vars carry the auth + session pointers.

    Server name ``geny`` → tools surface as
    ``mcp__geny__<tool_name>`` in the CLI's tool list.
    """
    return {
        "mcpServers": {
            "geny": {
                "type": "stdio",
                "command": sys.executable,
                "args": [str(_BRIDGE_SCRIPT_PATH)],
                "env": {
                    "GENY_MCP_URL": ctx.base_url,
                    "GENY_MCP_TOKEN": ctx.token,
                    "GENY_MCP_SESSION_ID": ctx.session_id,
                },
            },
        },
    }


class CredentialBundleBuilder:
    """Turn the live Geny config into a frozen :class:`CredentialBundle`.

    Usage (legacy)::

        builder = CredentialBundleBuilder()
        bundle = builder.build()

    Usage with Phase I MCP bridge wiring::

        ctx = McpBridgeContext(session_id, token)
        builder = CredentialBundleBuilder(mcp_bridge=ctx)
        bundle = builder.build()
        # bundle.get("claude_code_cli").extras["mcp_config"] now
        # includes the per-session ``geny`` MCP server.

    The builder reads from ``get_config_manager()`` on every ``build()``
    call so it picks up live edits.
    """

    def __init__(
        self,
        config_manager: Any | None = None,
        *,
        mcp_bridge: Optional[McpBridgeContext] = None,
    ) -> None:
        self._cm = config_manager or get_config_manager()
        self._mcp_bridge = mcp_bridge

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
            by_provider["claude_code_cli"] = self._build_claude_code(
                creds, claude_cli, mcp_bridge=self._mcp_bridge,
            )
        if copilot_cli.enabled:
            by_provider["copilot_cli"] = self._build_copilot(copilot_cli)

        return CredentialBundle(by_provider=by_provider)

    # ────────────────────────────────────────────────── claude_code_cli ─

    def _build_claude_code(
        self,
        creds: LLMCredentialsConfig,
        claude_cli: CLIBackendClaudeCodeConfig,
        *,
        mcp_bridge: Optional[McpBridgeContext] = None,
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
        # Allow-tools CSV from the settings card lets the operator
        # opt back in to specific CLI built-ins (e.g. ``Bash`` for
        # debugging). Executor 2.0.5 honours this — when allow_tools
        # is set, the auto-``--tools ""`` disable is skipped so the
        # MCP server + curated built-ins both surface to the LLM.
        allow_tools = _split_csv(claude_cli.allow_tools_csv)
        extras: Dict[str, Any] = {
            "workspace_root": claude_cli.workspace_root or None,
            "bare_mode": bool(claude_cli.bare_mode),
            "default_permission_mode": claude_cli.default_permission_mode or "default",
            "allow_tools": allow_tools,
            "disallow_tools": _split_csv(claude_cli.disallow_tools_csv),
            "extra_args": _split_csv(claude_cli.extra_args_csv),
            "timeout_s": float(claude_cli.timeout_s) if claude_cli.timeout_s else 300.0,
        }
        if claude_cli.max_budget_usd and claude_cli.max_budget_usd > 0:
            extras["max_budget_usd"] = float(claude_cli.max_budget_usd)
        if claude_cli.settings_path:
            extras["settings_path"] = claude_cli.settings_path

        # Phase I — Geny tools MCP bridge. When the caller wires a
        # session-scoped bridge context, we synthesise the MCP config
        # that points the CLI at our stdio bridge subprocess. The
        # executor's ``ClaudeCodeCLIClient`` accepts ``mcp_config``
        # via constructor kwarg (read from ``extras["mcp_config"]``
        # by the pipeline's ``_creds_to_client_kwargs``), then emits
        # ``--mcp-config <json>`` + ``--tools ""`` (when no explicit
        # allow_tools) + ``--strict-mcp-config`` automatically per
        # executor 2.0.5.
        #
        # Settings-card ``mcp_config_path`` is a *legacy* per-host
        # static path. The session bridge wins so a single source of
        # truth governs the per-session tool surface; mixed surfaces
        # can be added later by merging the dicts here.
        if mcp_bridge is not None:
            extras["mcp_config"] = _build_mcp_bridge_config(mcp_bridge)
        elif claude_cli.mcp_config_path:
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
