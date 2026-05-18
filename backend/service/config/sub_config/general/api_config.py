"""
LLM Defaults — model selection + Anthropic-side knobs.

Phase H of the LLM backend upgrade cycle. Credentials
(``anthropic_api_key`` / ``openai_api_key`` / ``google_api_key`` /
``base_url``) moved out into ``LLMCredentialsConfig``, edited only
through the LLM Backends panel. The global ``provider`` field is
gone — provider selection is per-Environment at the manifest level,
not a global setting.

What remains here are the LLM defaults that are legitimately
"general" settings: which Claude model to default to for CLI vs
VTuber vs memory work, the Extended Thinking token budget, and the
service-wide port + permission-prompt knob.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List

from service.config.base import BaseConfig, ConfigField, FieldType, register_config
from service.config.sub_config.general.env_utils import env_sync, read_env_defaults

MODEL_OPTIONS = [
    {"value": "claude-opus-4-6", "label": "Claude Opus 4.6"},
    {"value": "claude-sonnet-4-6", "label": "Claude Sonnet 4.6"},
    {"value": "claude-opus-4-5-20251101", "label": "Claude Opus 4.5"},
    {"value": "claude-sonnet-4-5-20250929", "label": "Claude Sonnet 4.5"},
    {"value": "claude-haiku-4-5-20251001", "label": "Claude Haiku 4.5"},
    {"value": "claude-opus-4-20250514", "label": "Claude Opus 4"},
    {"value": "claude-sonnet-4-20250514", "label": "Claude Sonnet 4"},
    {"value": "claude-haiku-4-20250414", "label": "Claude Haiku 4"},
]


@register_config
@dataclass
class APIConfig(BaseConfig):
    """LLM model defaults + permission / port knobs."""

    anthropic_model: str = "claude-sonnet-4-6"
    vtuber_default_model: str = "claude-haiku-4-5-20251001"
    memory_model: str = "claude-haiku-4-5-20251001"
    use_legacy_reflect: bool = False
    max_thinking_tokens: int = 31999
    skip_permissions: bool = True
    app_port: int = 8000

    _ENV_MAP = {
        "anthropic_model": "ANTHROPIC_MODEL",
        "vtuber_default_model": "VTUBER_DEFAULT_MODEL",
        "memory_model": "MEMORY_MODEL",
        "use_legacy_reflect": "USE_LEGACY_REFLECT",
        "max_thinking_tokens": "MAX_THINKING_TOKENS",
        "skip_permissions": "CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS",
        "app_port": "APP_PORT",
    }

    @classmethod
    def get_default_instance(cls) -> "APIConfig":
        defaults = read_env_defaults(cls._ENV_MAP, cls.__dataclass_fields__)
        return cls(**defaults)

    @classmethod
    def get_config_name(cls) -> str:
        return "api"

    @classmethod
    def get_display_name(cls) -> str:
        return "LLM Defaults"

    @classmethod
    def get_description(cls) -> str:
        return (
            "Default models for CLI / VTuber / memory paths, Extended "
            "Thinking budget, permission mode, and the backend port. "
            "API keys live under LLM Backends."
        )

    @classmethod
    def get_category(cls) -> str:
        return "general"

    @classmethod
    def get_icon(cls) -> str:
        return "api"

    @classmethod
    def get_i18n(cls) -> Dict[str, Dict[str, Any]]:
        return {
            "ko": {
                "display_name": "LLM 기본 설정",
                "description": "CLI / VTuber / 메모리 경로의 기본 모델, Extended Thinking 토큰 예산, 권한 모드, 백엔드 포트. API 키는 LLM Backends에서 설정합니다.",
                "groups": {
                    "api": "Model Defaults",
                    "permissions": "Permissions",
                },
                "fields": {
                    "anthropic_model": {
                        "label": "Default Model",
                        "description": "Default Claude model for CLI sessions",
                    },
                    "vtuber_default_model": {
                        "label": "VTuber Default Model",
                        "description": "Default Claude model for VTuber sessions",
                    },
                    "memory_model": {
                        "label": "Memory Model",
                        "description": "메모리 게이트/인사이트 추출 전용 경량 모델 (비워두면 메인 모델 사용)",
                    },
                    "use_legacy_reflect": {
                        "label": "Use legacy LLM reflection (hardcoded Haiku)",
                        "description": "기본 Off — 메모리 반영은 geny-executor의 s15 단계에서 Memory Model 설정으로 실행됩니다.",
                    },
                    "max_thinking_tokens": {
                        "label": "Max Thinking Tokens",
                        "description": "Extended Thinking budget (set to 0 to disable)",
                    },
                    "skip_permissions": {
                        "label": "Skip Permission Prompts",
                        "description": "⚠️ Autonomous mode — skip all confirmation dialogs",
                    },
                    "app_port": {
                        "label": "Backend Port",
                        "description": "Backend server port (used for MCP proxy connections)",
                    },
                },
            }
        }

    @classmethod
    def get_fields_metadata(cls) -> List[ConfigField]:
        return [
            ConfigField(
                name="anthropic_model",
                field_type=FieldType.SELECT,
                label="Default Model",
                description="Default Claude model for CLI sessions",
                default="claude-sonnet-4-6",
                options=MODEL_OPTIONS,
                group="api",
                apply_change=env_sync("ANTHROPIC_MODEL"),
            ),
            ConfigField(
                name="vtuber_default_model",
                field_type=FieldType.SELECT,
                label="VTuber Default Model",
                description="Default Claude model for VTuber sessions (lightweight recommended)",
                default="claude-haiku-4-5-20251001",
                options=MODEL_OPTIONS,
                group="api",
                apply_change=env_sync("VTUBER_DEFAULT_MODEL"),
            ),
            ConfigField(
                name="memory_model",
                field_type=FieldType.SELECT,
                label="Memory Model",
                description="Lightweight model for memory gate & reflect (empty = use main model)",
                default="claude-haiku-4-5-20251001",
                options=[{"value": "", "label": "Same as main model"}] + MODEL_OPTIONS,
                group="api",
                apply_change=env_sync("MEMORY_MODEL"),
            ),
            ConfigField(
                name="use_legacy_reflect",
                field_type=FieldType.BOOLEAN,
                label="Use legacy LLM reflection (hardcoded Haiku)",
                description=(
                    "Off (default): memory reflection runs via the geny-executor "
                    "memory stage, using the Memory Model above. "
                    "On: falls back to the pre-cycle hardcoded-Haiku callback path."
                ),
                default=False,
                group="api",
                apply_change=env_sync("USE_LEGACY_REFLECT"),
            ),
            ConfigField(
                name="max_thinking_tokens",
                field_type=FieldType.NUMBER,
                label="Max Thinking Tokens",
                description="Extended Thinking budget (0 to disable)",
                default=31999,
                min_value=0,
                max_value=128000,
                group="api",
                apply_change=env_sync("MAX_THINKING_TOKENS"),
            ),
            ConfigField(
                name="skip_permissions",
                field_type=FieldType.BOOLEAN,
                label="Skip Permission Prompts",
                description="⚠️ Autonomous mode — skip all confirmation dialogs",
                default=True,
                group="permissions",
                apply_change=env_sync("CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS"),
            ),
            ConfigField(
                name="app_port",
                field_type=FieldType.NUMBER,
                label="Backend Port",
                description="Backend server port (used for MCP proxy connections)",
                default=8000,
                min_value=1,
                max_value=65535,
                group="api",
                apply_change=env_sync("APP_PORT"),
            ),
        ]
