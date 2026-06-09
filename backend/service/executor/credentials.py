"""Build :class:`geny_executor.CredentialBundle` from Geny's settings.

Phase H of the LLM backend upgrade cycle. The API credentials moved
out of ``APIConfig`` into a dedicated hidden ``LLMCredentialsConfig``
(edited only through the LLM Backends panel); ``CLIBackendClaudeCodeConfig``
is also hidden from the general list. This builder unifies both into the
single :class:`CredentialBundle` channel that
``Pipeline.from_manifest_async`` consumes.

The bundle is built fresh per session so a user toggling a backend on
or off (or rotating a key) takes effect on the next session create.

Phase I (``mcp_bridge=...``): when a session pins ``claude_code_cli``
as the Stage 6 provider, the builder synthesises a per-session MCP
config that wraps Geny's tool registry (via the
``backend/scripts/geny_mcp_bridge.py`` stdio bridge → HTTP endpoint).
The CLI's LLM then sees Geny tools as ``mcp__geny__<name>``.

Cycle 20260520 — the legacy ``copilot_cli`` provider was removed. The
``gh copilot`` CLI does not support streaming, tools, or MCP, so it
cannot host Geny's Sub-Worker delegation or Stage-10 dispatch. Its
config + credential builder + auth controller + frontend card were all
deleted; only ``claude_code_cli`` remains on the CLI-driven path.
"""

from __future__ import annotations

import json
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

        # Include ``claude_code_cli`` either when the operator explicitly
        # toggled it on OR when ``LLMCredentialsConfig.default_provider``
        # pins it as the global backend. Without the second condition,
        # setting ``default_provider="claude_code_cli"`` does nothing
        # because the session-create validator still sees an empty
        # bundle entry and rejects the session before pipeline build.
        default_provider = (creds.default_provider or "").strip()
        if claude_cli.enabled or default_provider == "claude_code_cli":
            by_provider["claude_code_cli"] = self._build_claude_code(
                creds, claude_cli, mcp_bridge=self._mcp_bridge,
            )

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
        # Only honour the per-card ``claude_cli.api_key`` field. Cascading
        # from ``creds.anthropic_api_key`` (the Anthropic provider's key)
        # silently forces API-key auth on the CLI even when the user has
        # completed OAuth login — the executor's ``_env_extras`` then
        # injects that key as ``ANTHROPIC_API_KEY`` into the subprocess,
        # and Claude Code prefers env-var auth over the OAuth credential
        # file at ``~/.claude/.credentials.json``. If the Anthropic key is
        # stale / wrong (very common — the user pasted it once, it later
        # got rotated, and they switched to Claude.ai subscription), every
        # session crashes with ``401 invalid x-api-key`` and the LLM
        # Backends card misleadingly shows ``auth=api_key`` while the
        # auth modal correctly shows ``로그인됨 / auth_method: claude.ai``.
        # Leave the field empty when the user wants OAuth — the CLI binary
        # will then read its own credential file.
        api_key = claude_cli.api_key
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
            # Claude Code CLI's default permission mode prompts the
            # user before dispatching each tool call. In ``--print``
            # (non-interactive) mode there is no terminal to answer
            # that prompt, so the CLI blocks the call and the LLM
            # surfaces "권한이 아직 없어서…" / "permission denied" to
            # the user even though the bridge would have happily
            # served it.
            #
            # ``--permission-mode bypassPermissions`` would skip all
            # checks but the CLI maps it to ``--dangerously-skip-permissions``
            # internally, which is hard-blocked when the spawning
            # process runs as ``root`` (our containerised case):
            #
            #   "--dangerously-skip-permissions cannot be used with
            #    root/sudo privileges for security reasons"
            #
            # Instead we pre-allow the entire ``geny`` MCP server via
            # the documented ``permissions.allow`` settings entry.
            # ``"mcp__geny"`` matches every tool advertised by the
            # bridge (the CLI normalises MCP tool names to
            # ``mcp__<server>__<tool>``) so the LLM can dispatch any
            # Geny tool without prompts, while the CLI's built-in
            # palette stays gated by ``--tools ""`` and any user-
            # supplied entries in the operator's settings_path are
            # preserved verbatim — we synthesise an *inline* JSON via
            # ``--settings`` only when the operator hasn't already
            # pinned a settings file (the executor's argv builder
            # passes whatever ``settings_path`` resolves to through
            # to ``--settings <file-or-json>`` unchanged, and the CLI
            # auto-detects file vs inline JSON).
            if not extras.get("settings_path"):
                # ``mcp__geny`` matches every tool advertised by our
                # bridge (the CLI normalises MCP tool names to
                # ``mcp__<server>__<tool>``). The bare names below
                # cover the Claude Code CLI's safe built-in palette
                # — Sub-Worker sessions in particular need
                # ``Bash`` / ``Read`` / ``Write`` / ``Edit`` to do
                # actual file work; without them in the allow-list,
                # the CLI's ``--print`` mode (which can't prompt a
                # human) blocks every call and the LLM apologises
                # mid-conversation ("messaging tool not connected").
                #
                # Entries are documented per claude-code's settings
                # schema: bare ``Tool`` = allow all invocations of
                # that tool; ``Tool(pattern)`` = pattern-restricted.
                # We intentionally do NOT list destructive system
                # tools (``KillBash``, ``WebSearch`` is fine —
                # ``Bash(rm *)`` would be the dangerous one and is
                # implicitly disallowed by listing only ``Bash``).
                _ALLOWED_CLI_BUILTINS = [
                    # MCP surface — every Geny tool the bridge exposes
                    "mcp__geny",
                    # File ops
                    "Read", "Write", "Edit", "MultiEdit",
                    "NotebookEdit",
                    # Filesystem search
                    "Glob", "Grep",
                    # Shell
                    "Bash",
                    # Planning / structured work
                    "TodoWrite", "EnterPlanMode", "ExitPlanMode",
                    # Web
                    "WebFetch", "WebSearch",
                    # Meta / orchestration
                    "Skill", "Agent", "AgentSearch", "ToolSearch",
                    "Monitor", "TaskOutput", "TaskStop",
                    # User interaction
                    "AskUserQuestion", "PushNotification",
                    "ScheduleWakeup", "RemoteTrigger",
                ]
                extras["settings_path"] = json.dumps(
                    {"permissions": {"allow": _ALLOWED_CLI_BUILTINS}}
                )
        elif claude_cli.mcp_config_path:
            extras["mcp_config"] = claude_cli.mcp_config_path
        return ProviderCredentials(
            api_key=api_key,
            binary_path=binary,
            extras=extras,
        )

