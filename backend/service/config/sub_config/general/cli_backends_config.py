"""CLI-backend (Claude Code) settings.

Phase E1 of the LLM backend upgrade cycle added CLI-driven LLM providers
to geny-executor — currently only ``claude_code_cli`` (a Stage-6 provider
that spawns the Claude Code CLI subprocess and wraps Geny's tool registry
through an MCP bridge per Phase I, ``docs/llm-backend-upgrade-plan/12_phase_i_claude_code_mcp_wrap.md``).

The ``copilot_cli`` provider was removed in cycle 20260520 — ``gh copilot``
fundamentally does not support streaming, tool round-trip, or MCP, so it
could only ever be a one-shot text-completion backend incompatible with
the Sub-Worker delegation / Stage 10 dispatch pipeline. See the same plan
doc + commit message for the full rationale.

``CLIBackendClaudeCodeConfig`` is a no-op until the user flips
``enabled=True``; until then the ``CredentialBundleBuilder`` does not
include it in the bundle.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List

from service.config.base import BaseConfig, ConfigField, FieldType, register_config
from service.config.sub_config.general.env_utils import env_sync, read_env_defaults


PERMISSION_MODE_OPTIONS = [
    {"value": "default", "label": "default"},
    {"value": "acceptEdits", "label": "acceptEdits"},
    {"value": "auto", "label": "auto"},
    {"value": "bypassPermissions", "label": "bypassPermissions"},
    {"value": "dontAsk", "label": "dontAsk"},
    {"value": "plan", "label": "plan"},
]


@register_config
@dataclass
class CLIBackendClaudeCodeConfig(BaseConfig):
    """Claude Code CLI backend settings.

    The fields map straight to ``ClaudeCodeCLIClient`` constructor
    kwargs via ``CredentialBundleBuilder``.
    """

    enabled: bool = False
    binary_path: str = ""                 # default: auto-detect via PATH
    workspace_root: str = ""              # session workspace; "" = use parent state cwd
    bare_mode: bool = True
    default_permission_mode: str = "default"
    max_budget_usd: float = 0.0            # 0 = no cap
    api_key: str = ""                      # blank → fall back to LLMCredentialsConfig.anthropic_api_key
    settings_path: str = ""                # --settings file
    mcp_config_path: str = ""              # --mcp-config <path>
    allow_tools_csv: str = ""              # comma-separated --allowedTools
    disallow_tools_csv: str = ""           # comma-separated --disallowedTools
    extra_args_csv: str = ""               # extra argv flags
    timeout_s: float = 300.0

    _ENV_MAP = {
        "enabled": "CLAUDE_CODE_ENABLED",
        "binary_path": "CLAUDE_CODE_BINARY",
        "workspace_root": "CLAUDE_CODE_WORKSPACE_ROOT",
    }

    @classmethod
    def get_default_instance(cls) -> "CLIBackendClaudeCodeConfig":
        defaults = read_env_defaults(cls._ENV_MAP, cls.__dataclass_fields__)
        return cls(**defaults)

    @classmethod
    def get_config_name(cls) -> str:
        return "cli_backend_claude_code"

    @classmethod
    def get_display_name(cls) -> str:
        return "Claude Code (CLI)"

    @classmethod
    def get_description(cls) -> str:
        return (
            "Settings for the Claude Code CLI backend. Drives the local "
            "``claude`` binary as a geny-executor LLM provider."
        )

    @classmethod
    def get_category(cls) -> str:
        return "general"

    @classmethod
    def get_icon(cls) -> str:
        return "terminal"

    @classmethod
    def is_user_visible(cls) -> bool:
        # Phase H — edited only through the LLM Backends panel's
        # ClaudeCodeAuthModal, not the auto-form list.
        return False

    @classmethod
    def get_i18n(cls) -> Dict[str, Dict[str, Any]]:
        return {
            "ko": {
                "display_name": "Claude Code (CLI)",
                "description": "로컬 claude CLI를 geny-executor의 LLM provider로 사용합니다.",
            }
        }

    @classmethod
    def get_fields_metadata(cls) -> List[ConfigField]:
        return [
            ConfigField(
                name="enabled",
                field_type=FieldType.BOOLEAN,
                label="Enabled",
                description="Activate the Claude Code CLI provider in CredentialBundle.",
                default=False,
                group="claude_code",
                apply_change=env_sync("CLAUDE_CODE_ENABLED"),
            ),
            ConfigField(
                name="binary_path",
                field_type=FieldType.STRING,
                label="Binary Path",
                description="Path to the ``claude`` binary. Empty = auto-detect via PATH.",
                default="",
                placeholder="/usr/local/bin/claude",
                group="claude_code",
                apply_change=env_sync("CLAUDE_CODE_BINARY"),
            ),
            ConfigField(
                name="workspace_root",
                field_type=FieldType.STRING,
                label="Workspace Root",
                description="CWD passed to the spawned claude subprocess. Empty = parent.",
                default="",
                group="claude_code",
                apply_change=env_sync("CLAUDE_CODE_WORKSPACE_ROOT"),
            ),
            ConfigField(
                name="bare_mode",
                field_type=FieldType.BOOLEAN,
                label="Bare Mode",
                description="Pass --bare so hooks / auto-memory / LSP / plugin sync are disabled (recommended).",
                default=True,
                group="claude_code",
            ),
            ConfigField(
                name="default_permission_mode",
                field_type=FieldType.SELECT,
                label="Permission Mode",
                description="Forwarded as --permission-mode. 'default' omits the flag.",
                default="default",
                options=PERMISSION_MODE_OPTIONS,
                group="claude_code",
            ),
            ConfigField(
                name="max_budget_usd",
                field_type=FieldType.NUMBER,
                label="Max Budget (USD)",
                description="Per-call budget cap (0 = no cap). Forwarded as --max-budget-usd.",
                default=0.0,
                min_value=0.0,
                group="claude_code",
            ),
            ConfigField(
                name="api_key",
                field_type=FieldType.PASSWORD,
                label="ANTHROPIC_API_KEY (override)",
                description="Optional. Blank = inherit LLMCredentialsConfig.anthropic_api_key.",
                default="",
                group="claude_code",
                secure=True,
            ),
            ConfigField(
                name="settings_path",
                field_type=FieldType.STRING,
                label="Settings file",
                description="Forwarded as --settings. Empty to skip.",
                default="",
                group="claude_code",
            ),
            ConfigField(
                name="mcp_config_path",
                field_type=FieldType.STRING,
                label="MCP config path",
                description="Forwarded as --mcp-config <path>. Empty to skip.",
                default="",
                group="claude_code",
            ),
            ConfigField(
                name="allow_tools_csv",
                field_type=FieldType.STRING,
                label="Allowed Tools (CSV)",
                description="Comma-separated. Forwarded via --allowedTools.",
                default="",
                placeholder="Read,Bash(git *),Edit",
                group="claude_code",
            ),
            ConfigField(
                name="disallow_tools_csv",
                field_type=FieldType.STRING,
                label="Disallowed Tools (CSV)",
                description="Comma-separated. Forwarded via --disallowedTools.",
                default="",
                group="claude_code",
            ),
            ConfigField(
                name="extra_args_csv",
                field_type=FieldType.STRING,
                label="Extra Args (CSV)",
                description="Escape hatch — additional argv tokens, comma-separated.",
                default="",
                group="claude_code",
            ),
            ConfigField(
                name="timeout_s",
                field_type=FieldType.NUMBER,
                label="Timeout (seconds)",
                description="Per-call wall-clock timeout. Default 300s.",
                default=300.0,
                min_value=10.0,
                max_value=3600.0,
                group="claude_code",
            ),
        ]


# ``CLIBackendCopilotConfig`` was removed in cycle 20260520. The
# ``gh copilot`` CLI advertises (and the upstream geny-executor's
# ``CopilotCLIClient`` honestly mirrors) ``supports_streaming=False``,
# ``supports_tools=False``, ``supports_mcp_passthrough=False`` — it is a
# one-shot text-in / text-out subprocess that cannot participate in
# Geny's Sub-Worker delegation or Stage-10 tool dispatch. Keeping the
# config card around encouraged operators to enable a backend that would
# immediately fail at the first tool call. Existing DB rows for
# ``cli_backend_copilot`` are harmlessly ignored.
