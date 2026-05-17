"""CLI-backend (Claude Code, GitHub Copilot) settings.

Phase E1 of the LLM backend upgrade cycle adds two new providers to
geny-executor (``claude_code_cli`` / ``copilot_cli``) that drive local
CLI binaries instead of vendor SDKs. These two configs let users
enable each backend, point at a specific binary, and override the
behavioural knobs (workspace, bare mode, budget, allowed tools, etc).

Both are no-ops until the user flips ``enabled=True``; until then the
``CredentialBundleBuilder`` does not include them in the bundle and
``ClientRegistry`` builds these clients with empty extras.
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
    api_key: str = ""                      # blank → fall back to APIConfig.anthropic_api_key
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
                description="Optional. Blank = inherit APIConfig.anthropic_api_key.",
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


@register_config
@dataclass
class CLIBackendCopilotConfig(BaseConfig):
    """GitHub Copilot CLI backend settings."""

    enabled: bool = False
    gh_binary_path: str = ""            # default: shutil.which("gh")
    allow_tools_csv: str = ""           # comma-separated --allow-tool scopes
    cwd: str = ""                       # working directory for the subprocess
    extra_args_csv: str = ""
    timeout_s: float = 180.0

    _ENV_MAP = {
        "enabled": "COPILOT_CLI_ENABLED",
        "gh_binary_path": "GH_BINARY",
    }

    @classmethod
    def get_default_instance(cls) -> "CLIBackendCopilotConfig":
        defaults = read_env_defaults(cls._ENV_MAP, cls.__dataclass_fields__)
        return cls(**defaults)

    @classmethod
    def get_config_name(cls) -> str:
        return "cli_backend_copilot"

    @classmethod
    def get_display_name(cls) -> str:
        return "GitHub Copilot (CLI)"

    @classmethod
    def get_description(cls) -> str:
        return (
            "Settings for the GitHub Copilot CLI backend. Drives ``gh copilot`` "
            "as a geny-executor LLM provider."
        )

    @classmethod
    def get_category(cls) -> str:
        return "general"

    @classmethod
    def get_icon(cls) -> str:
        return "terminal"

    @classmethod
    def get_i18n(cls) -> Dict[str, Dict[str, Any]]:
        return {
            "ko": {
                "display_name": "GitHub Copilot (CLI)",
                "description": "로컬 gh copilot CLI를 geny-executor의 LLM provider로 사용합니다.",
            }
        }

    @classmethod
    def get_fields_metadata(cls) -> List[ConfigField]:
        return [
            ConfigField(
                name="enabled",
                field_type=FieldType.BOOLEAN,
                label="Enabled",
                description="Activate the Copilot CLI provider in CredentialBundle.",
                default=False,
                group="copilot",
                apply_change=env_sync("COPILOT_CLI_ENABLED"),
            ),
            ConfigField(
                name="gh_binary_path",
                field_type=FieldType.STRING,
                label="gh Binary Path",
                description="Path to the gh CLI. Empty = auto-detect via PATH.",
                default="",
                placeholder="/usr/local/bin/gh",
                group="copilot",
                apply_change=env_sync("GH_BINARY"),
            ),
            ConfigField(
                name="allow_tools_csv",
                field_type=FieldType.STRING,
                label="Allow-Tool scopes (CSV)",
                description="Comma-separated. Each becomes a --allow-tool flag.",
                default="",
                placeholder="shell(git),fs(read)",
                group="copilot",
            ),
            ConfigField(
                name="cwd",
                field_type=FieldType.STRING,
                label="CWD",
                description="Working directory for the spawned gh process.",
                default="",
                group="copilot",
            ),
            ConfigField(
                name="extra_args_csv",
                field_type=FieldType.STRING,
                label="Extra Args (CSV)",
                description="Escape hatch — additional argv tokens, comma-separated.",
                default="",
                group="copilot",
            ),
            ConfigField(
                name="timeout_s",
                field_type=FieldType.NUMBER,
                label="Timeout (seconds)",
                description="Per-call wall-clock timeout. Default 180s.",
                default=180.0,
                min_value=10.0,
                max_value=600.0,
                group="copilot",
            ),
        ]
