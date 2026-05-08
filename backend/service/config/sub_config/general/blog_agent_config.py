"""
Blog Agent Configuration.

외부 블로그 (https://hrletsgo.me) 의 AI Agent 위임 통합 설정.

Settings UI 의 General 카테고리에 'Blog Agent' 카드로 노출되며,
운영자가 .env 없이도 8개 필드를 동적으로 편집할 수 있다.
.env 의 BLOG_AGENT_* 키는 부팅 시점의 default seed 로만 동작 —
이후엔 ConfigManager 가 우선.

블로그 측 지원 모델은 blog frontend 의 ``AVAILABLE_MODELS``
(:file:`hr_blog2.0/frontend/src/src/components/agent/AgentSettingsModal.tsx`)
와 1:1 동기화. blog 가 새 모델을 추가하면 이 리스트도 갱신해야 한다.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List

from service.config.base import BaseConfig, ConfigField, FieldType, register_config
from service.config.sub_config.general.env_utils import env_sync, read_env_defaults


# ─── 블로그 측 지원 모델 — frontend AVAILABLE_MODELS 와 동기화 ─────
#
# blog 의 외부 API 는 model 값을 자유 문자열로 받지만, 실제로 검증된
# 옵션은 frontend AgentSettingsModal 의 AVAILABLE_MODELS (3종):
#
#   - claude-opus-4-7              최고 추론력
#   - claude-sonnet-4-6            균형 (권장 default)
#   - claude-haiku-4-5-20251001    빠르고 저렴
#
# blog 가 새 모델을 추가하면 이 리스트도 갱신.
BLOG_AGENT_MODEL_OPTIONS: List[Dict[str, str]] = [
    {"value": "claude-opus-4-7", "label": "Claude Opus 4.7 (최고 추론력)"},
    {"value": "claude-sonnet-4-6", "label": "Claude Sonnet 4.6 (균형 · 권장)"},
    {"value": "claude-haiku-4-5-20251001", "label": "Claude Haiku 4.5 (빠르고 저렴)"},
    {"value": "gpt-5.5", "label": "OpenAI GPT-5.5 (다른 문체)"},
    {"value": "gpt-5.4", "label": "OpenAI GPT-5.4 (균형)"},
    {"value": "gpt-5.4-mini", "label": "OpenAI GPT-5.4 mini (저렴)"},
]


# ─── 블로그 측 prompt voice mode ───────────────────────
# blog backend 의 ``PROMPT_MODES`` (system_prompt.py) 와 1:1 동기화.
# 새 mode 가 blog 에 추가되면 이 리스트도 갱신.
BLOG_AGENT_PROMPT_MODE_OPTIONS: List[Dict[str, str]] = [
    {"value": "persona", "label": "Persona (25세 카주얼 블로거 · default)"},
    {"value": "research", "label": "Research (진지 정보·사실 서술)"},
    {"value": "explorer", "label": "Explorer (탐색 도우미 · read 도구 우선)"},
]


@register_config
@dataclass
class BlogAgentConfig(BaseConfig):
    """블로그 AI Agent 위임 설정."""

    base_url: str = "https://hrletsgo.me"
    api_key: str = ""
    default_model: str = "claude-sonnet-4-6"
    # 블로그 system_prompt voice mode — 새 세션 / 미지정 호출에 적용.
    # delegate 도구 호출자가 prompt_mode 인자를 명시하면 그 값이 우선.
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
            "외부 블로그 AI Agent (예: hrletsgo.me) 에 글쓰기 / 편집 작업을 "
            "위임하는 통합 설정. API 키는 admin 비밀번호와 동일한 무게로 "
            "다룰 것."
        )

    @classmethod
    def get_category(cls) -> str:
        return "general"

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
            # ── 연결 ──────────────────────────────────────
            ConfigField(
                name="base_url",
                field_type=FieldType.URL,
                label="Base URL",
                description="블로그 외부 API base URL (도메인까지만, path 없음)",
                placeholder="https://hrletsgo.me",
                group="connection",
                apply_change=env_sync("BLOG_AGENT_BASE_URL"),
            ),
            ConfigField(
                name="api_key",
                field_type=FieldType.PASSWORD,
                label="API Key",
                description=(
                    "블로그 외부 API Bearer 토큰. 블로그 admin → Settings "
                    "→ External API 에서 발급. admin 비밀번호와 동일한 무게."
                ),
                placeholder="32-hex-chars",
                group="connection",
                secure=True,
                apply_change=env_sync("BLOG_AGENT_API_KEY"),
            ),
            ConfigField(
                name="enabled",
                field_type=FieldType.BOOLEAN,
                label="활성화",
                description=(
                    "OFF 일 때는 모든 blog_agent_* 도구가 즉시 명시적 에러를 "
                    "반환 — 키나 URL 이 비어 있어도 안전."
                ),
                group="connection",
                apply_change=env_sync("BLOG_AGENT_ENABLED"),
            ),
            # ── 동작 ──────────────────────────────────────
            ConfigField(
                name="default_model",
                field_type=FieldType.SELECT,
                label="기본 모델",
                description=(
                    "위임 시 블로그 SDK 가 사용할 Claude 모델. blog frontend "
                    "AVAILABLE_MODELS 와 동기화된 옵션."
                ),
                options=BLOG_AGENT_MODEL_OPTIONS,
                group="behavior",
                apply_change=env_sync("BLOG_AGENT_DEFAULT_MODEL"),
            ),
            ConfigField(
                name="default_prompt_mode",
                field_type=FieldType.SELECT,
                label="기본 Voice",
                description=(
                    "위임 시 블로그 system_prompt 의 voice mode. delegate 도구 "
                    "호출자가 prompt_mode 인자를 명시하지 않으면 이 값이 적용. "
                    "persona = 25세 카주얼 블로거, research = 진지 정보 톤."
                ),
                options=BLOG_AGENT_PROMPT_MODE_OPTIONS,
                group="behavior",
                apply_change=env_sync("BLOG_AGENT_DEFAULT_PROMPT_MODE"),
            ),
            ConfigField(
                name="default_timeout_s",
                field_type=FieldType.NUMBER,
                label="Stream 타임아웃 (초)",
                description=(
                    "한 위임 turn 의 최대 SSE 수신 시간. 본문 자율 작성처럼 "
                    "긴 turn 도 커버하도록 600 초 default."
                ),
                group="behavior",
                min_value=30.0,
                max_value=3600.0,
                apply_change=env_sync("BLOG_AGENT_DEFAULT_TIMEOUT_S"),
            ),
            ConfigField(
                name="pump_idle_grace_s",
                field_type=FieldType.NUMBER,
                label="Idle 허용 시간 (초)",
                description=(
                    "SSE frame 이 N초 이상 안 오면 'last_event_age_s' 가 "
                    "올라가 status 도구가 사용자에게 'stuck' 신호를 줌."
                ),
                group="behavior",
                min_value=5.0,
                max_value=600.0,
                apply_change=env_sync("BLOG_AGENT_PUMP_IDLE_GRACE_S"),
            ),
            ConfigField(
                name="max_concurrent_per_session",
                field_type=FieldType.NUMBER,
                label="세션당 동시 위임 상한",
                description=(
                    "한 Geny 세션이 동시에 진행할 수 있는 위임 task 수. "
                    "초과 시 도구가 명시적 에러로 거부."
                ),
                group="behavior",
                min_value=1,
                max_value=10,
                apply_change=env_sync("BLOG_AGENT_MAX_CONCURRENT_PER_SESSION"),
            ),
            # ── 접근 제어 ─────────────────────────────────
            ConfigField(
                name="enabled_for_subworkers",
                field_type=FieldType.BOOLEAN,
                label="Sub-Worker 에 노출",
                description=(
                    "기본 OFF — VTuber 만 위임 도구를 본다. ON 으로 바꾸면 "
                    "Worker env template 의 deny 세트가 비워져 Sub-Worker / "
                    "Developer / Researcher / Planner 도 도구를 받음 "
                    "(템플릿 재생성 필요 — Geny 재기동 시 자동 적용)."
                ),
                group="access",
                apply_change=env_sync("BLOG_AGENT_ENABLED_FOR_SUBWORKERS"),
            ),
        ]
