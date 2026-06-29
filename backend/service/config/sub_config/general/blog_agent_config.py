"""
Blog Agent Configuration.

Integration settings for delegating to an external blog's AI Agent
(https://hrletsgo.me).

Surfaces as the 'Blog Agent' card in the General category of the Settings UI,
letting an operator edit all 8 fields dynamically without touching .env.
The .env BLOG_AGENT_* keys act only as the boot-time default seed —
after that, ConfigManager takes precedence.

The blog's supported models stay in 1:1 sync with the blog frontend's
``AVAILABLE_MODELS``
(:file:`hr_blog2.0/frontend/src/src/components/agent/AgentSettingsModal.tsx`).
When the blog adds a new model, this list must be updated too.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List

from service.config.base import BaseConfig, ConfigField, FieldType, register_config
from service.config.sub_config.general.env_utils import env_sync, read_env_defaults


# ─── Blog-side supported models — kept in sync with frontend AVAILABLE_MODELS ─────
#
# The blog's external API accepts the model value as a free-form string, but the
# actually validated options are the frontend AgentSettingsModal's AVAILABLE_MODELS
# (3 of them):
#
#   - claude-opus-4-7              strongest reasoning
#   - claude-sonnet-4-6            balanced (recommended default)
#   - claude-haiku-4-5-20251001    fast and cheap
#
# When the blog adds a new model, update this list too.
BLOG_AGENT_MODEL_OPTIONS: List[Dict[str, str]] = [
    {"value": "claude-opus-4-7", "label": "Claude Opus 4.7 (strongest reasoning)"},
    {"value": "claude-sonnet-4-6", "label": "Claude Sonnet 4.6 (balanced · recommended)"},
    {"value": "claude-haiku-4-5-20251001", "label": "Claude Haiku 4.5 (fast and cheap)"},
    {"value": "gpt-5.5", "label": "OpenAI GPT-5.5 (different writing style)"},
    {"value": "gpt-5.4", "label": "OpenAI GPT-5.4 (balanced)"},
    {"value": "gpt-5.4-mini", "label": "OpenAI GPT-5.4 mini (cheap)"},
]


# ─── Blog-side prompt voice mode ───────────────────────
# Kept in 1:1 sync with the blog backend's ``PROMPT_MODES`` (system_prompt.py).
# When a new mode is added to the blog, update this list too.
BLOG_AGENT_PROMPT_MODE_OPTIONS: List[Dict[str, str]] = [
    {"value": "persona", "label": "Persona (25-year-old casual blogger · default)"},
    {"value": "research", "label": "Research (serious, fact-based reporting)"},
    {"value": "explorer", "label": "Explorer (exploration helper · prefers read tools)"},
]


@register_config
@dataclass
class BlogAgentConfig(BaseConfig):
    """Blog AI Agent delegation settings."""

    base_url: str = "https://hrletsgo.me"
    api_key: str = ""
    default_model: str = "claude-sonnet-4-6"
    # Blog system_prompt voice mode — applied to new sessions / unspecified calls.
    # If the delegate tool caller specifies the prompt_mode argument, that value wins.
    default_prompt_mode: str = "persona"
    default_timeout_s: float = 600.0
    pump_idle_grace_s: float = 30.0
    enabled: bool = False
    enabled_for_subworkers: bool = False
    max_concurrent_per_session: int = 2

    _ENV_MAP = {
        "base_url": "BLOG_AGENT_BASE_URL",
        "api_key": "BLOG_AGENT_API_KEY",
        "default_model": "BLOG_AGENT_DEFAULT_MODEL",
        "default_prompt_mode": "BLOG_AGENT_DEFAULT_PROMPT_MODE",
        "default_timeout_s": "BLOG_AGENT_DEFAULT_TIMEOUT_S",
        "pump_idle_grace_s": "BLOG_AGENT_PUMP_IDLE_GRACE_S",
        "enabled": "BLOG_AGENT_ENABLED",
        "enabled_for_subworkers": "BLOG_AGENT_ENABLED_FOR_SUBWORKERS",
        "max_concurrent_per_session": "BLOG_AGENT_MAX_CONCURRENT_PER_SESSION",
    }

    @classmethod
    def get_default_instance(cls) -> "BlogAgentConfig":
        defaults = read_env_defaults(cls._ENV_MAP, cls.__dataclass_fields__)
        return cls(**defaults)

    @classmethod
    def get_config_name(cls) -> str:
        return "blog_agent"

    @classmethod
    def get_display_name(cls) -> str:
        return "Blog Agent"

    @classmethod
    def get_description(cls) -> str:
        return (
            "Integration settings for delegating writing / editing tasks to an "
            "external blog AI Agent (e.g. hrletsgo.me). Treat the API key with the "
            "same care as the admin password."
        )

    @classmethod
    def get_category(cls) -> str:
        return "tools"

    @classmethod
    def get_icon(cls) -> str:
        return "edit"

    @classmethod
    def get_i18n(cls) -> Dict[str, Dict[str, Any]]:
        return {
            "ko": {
                "display_name": "블로그 에이전트",
                "description": (
                    "외부 블로그(예: hrletsgo.me)의 AI Agent에게 글쓰기/편집을 "
                    "위임하기 위한 설정. API 키는 admin 비밀번호와 동일한 "
                    "무게로 다룰 것."
                ),
                "groups": {
                    "connection": "연결",
                    "behavior": "동작",
                    "access": "접근 제어",
                },
                "fields": {
                    "base_url": {
                        "label": "Base URL",
                        "description": "블로그 외부 API base URL (예: https://hrletsgo.me)",
                    },
                    "api_key": {
                        "label": "API Key",
                        "description": "블로그 외부 API Bearer 토큰",
                    },
                    "default_model": {
                        "label": "기본 모델",
                        "description": "위임 시 블로그 SDK 가 사용할 모델",
                    },
                    "default_prompt_mode": {
                        "label": "기본 Voice",
                        "description": (
                            "위임 시 블로그 system_prompt 의 voice mode. "
                            "persona = 25세 카주얼 블로거, research = 진지 정보 톤. "
                            "delegate 도구 호출자가 명시하면 그 값이 우선."
                        ),
                    },
                    "default_timeout_s": {
                        "label": "Stream 타임아웃 (초)",
                        "description": "한 위임 turn 의 최대 SSE 수신 시간",
                    },
                    "pump_idle_grace_s": {
                        "label": "Idle 허용 시간 (초)",
                        "description": "SSE frame 이 N초 이상 안 오면 transient 경고",
                    },
                    "enabled": {
                        "label": "활성화",
                        "description": "OFF면 모든 blog_agent_* 도구가 명시적 에러 반환",
                    },
                    "enabled_for_subworkers": {
                        "label": "Sub-Worker 노출",
                        "description": (
                            "기본 OFF — Sub-Worker 가 블로그 위임 도구를 보지 못함. "
                            "ON 으로 바꾸면 Worker 환경 템플릿에도 도구가 들어감 "
                            "(env 템플릿 재생성 필요)."
                        ),
                    },
                    "max_concurrent_per_session": {
                        "label": "세션당 동시 위임 상한",
                        "description": "한 Geny 세션이 동시에 진행할 수 있는 위임 task 수",
                    },
                },
            }
        }

    @classmethod
    def get_fields_metadata(cls) -> List[ConfigField]:
        return [
            # ── Connection ──────────────────────────────────────
            ConfigField(
                name="base_url",
                field_type=FieldType.URL,
                label="Base URL",
                description="Blog external API base URL (domain only, no path)",
                placeholder="https://hrletsgo.me",
                group="connection",
                apply_change=env_sync("BLOG_AGENT_BASE_URL"),
            ),
            ConfigField(
                name="api_key",
                field_type=FieldType.PASSWORD,
                label="API Key",
                description=(
                    "Blog external API Bearer token. Issued from the blog "
                    "admin → Settings → External API. Treat it with the same "
                    "care as the admin password."
                ),
                placeholder="32-hex-chars",
                group="connection",
                secure=True,
                apply_change=env_sync("BLOG_AGENT_API_KEY"),
            ),
            ConfigField(
                name="enabled",
                field_type=FieldType.BOOLEAN,
                label="Enabled",
                description=(
                    "When OFF, every blog_agent_* tool returns an explicit error "
                    "immediately — safe even if the key or URL is empty."
                ),
                group="connection",
                apply_change=env_sync("BLOG_AGENT_ENABLED"),
            ),
            # ── Behavior ──────────────────────────────────────
            ConfigField(
                name="default_model",
                field_type=FieldType.SELECT,
                label="Default Model",
                description=(
                    "Claude model the blog SDK uses when delegating. Options kept "
                    "in sync with the blog frontend's AVAILABLE_MODELS."
                ),
                options=BLOG_AGENT_MODEL_OPTIONS,
                group="behavior",
                apply_change=env_sync("BLOG_AGENT_DEFAULT_MODEL"),
            ),
            ConfigField(
                name="default_prompt_mode",
                field_type=FieldType.SELECT,
                label="Default Voice",
                description=(
                    "Voice mode of the blog system_prompt when delegating. Applied "
                    "when the delegate tool caller does not specify the prompt_mode "
                    "argument. persona = 25-year-old casual blogger, "
                    "research = serious informational tone."
                ),
                options=BLOG_AGENT_PROMPT_MODE_OPTIONS,
                group="behavior",
                apply_change=env_sync("BLOG_AGENT_DEFAULT_PROMPT_MODE"),
            ),
            ConfigField(
                name="default_timeout_s",
                field_type=FieldType.NUMBER,
                label="Stream Timeout (seconds)",
                description=(
                    "Maximum SSE receive time for one delegation turn. Defaults to "
                    "600 seconds to cover long turns such as autonomous body writing."
                ),
                group="behavior",
                min_value=30.0,
                max_value=3600.0,
                apply_change=env_sync("BLOG_AGENT_DEFAULT_TIMEOUT_S"),
            ),
            ConfigField(
                name="pump_idle_grace_s",
                field_type=FieldType.NUMBER,
                label="Idle Grace Time (seconds)",
                description=(
                    "If no SSE frame arrives for N seconds, 'last_event_age_s' "
                    "rises and the status tool signals 'stuck' to the user."
                ),
                group="behavior",
                min_value=5.0,
                max_value=600.0,
                apply_change=env_sync("BLOG_AGENT_PUMP_IDLE_GRACE_S"),
            ),
            ConfigField(
                name="max_concurrent_per_session",
                field_type=FieldType.NUMBER,
                label="Max Concurrent Delegations Per Session",
                description=(
                    "Number of delegation tasks one Geny session can run "
                    "concurrently. Beyond that, the tool rejects with an explicit error."
                ),
                group="behavior",
                min_value=1,
                max_value=10,
                apply_change=env_sync("BLOG_AGENT_MAX_CONCURRENT_PER_SESSION"),
            ),
            # ── Access control ─────────────────────────────────
            ConfigField(
                name="enabled_for_subworkers",
                field_type=FieldType.BOOLEAN,
                label="Expose to Sub-Worker",
                description=(
                    "Default OFF — only the VTuber sees the delegation tools. "
                    "Turning it ON clears the deny set in the Worker env template so "
                    "Sub-Worker / Developer / Researcher / Planner also receive the "
                    "tools (template regeneration required — applied automatically "
                    "on Geny restart)."
                ),
                group="access",
                apply_change=env_sync("BLOG_AGENT_ENABLED_FOR_SUBWORKERS"),
            ),
        ]
