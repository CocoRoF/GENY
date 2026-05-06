"""
Blog Agent Configuration.

외부 블로그 (https://hrletsgo.me) 의 AI Agent 위임 통합 설정.

다음 환경변수를 .env 또는 settings UI 로부터 받아온다:

    BLOG_AGENT_BASE_URL                 블로그 외부 API base URL
    BLOG_AGENT_API_KEY                  Bearer 토큰 (admin 비밀번호 무게)
    BLOG_AGENT_DEFAULT_MODEL            블로그 측 SDK 모델 default
    BLOG_AGENT_DEFAULT_TIMEOUT_S        한 turn 의 최대 stream 수신 시간
    BLOG_AGENT_PUMP_IDLE_GRACE_S        SSE frame 미수신 허용 시간 (transient)
    BLOG_AGENT_ENABLED                  마스터 스위치
    BLOG_AGENT_ENABLED_FOR_SUBWORKERS   Sub-Worker 노출 여부 (기본 OFF)
    BLOG_AGENT_MAX_CONCURRENT_PER_SESSION  세션당 동시 위임 task 상한
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List

from service.config.base import BaseConfig, ConfigField, FieldType, register_config
from service.config.sub_config.general.env_utils import env_sync, read_env_defaults


@register_config
@dataclass
class BlogAgentConfig(BaseConfig):
    """블로그 AI Agent 위임 설정."""

    base_url: str = "https://hrletsgo.me"
    api_key: str = ""
    default_model: str = "claude-sonnet-4-6"
    default_timeout_s: float = 600.0
    pump_idle_grace_s: float = 30.0
    enabled: bool = False
    enabled_for_subworkers: bool = False
    max_concurrent_per_session: int = 2

    _ENV_MAP = {
        "base_url": "BLOG_AGENT_BASE_URL",
        "api_key": "BLOG_AGENT_API_KEY",
        "default_model": "BLOG_AGENT_DEFAULT_MODEL",
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
            "Delegate writing/editing tasks to the external blog AI agent at "
            "the configured base URL. Treat the API key as admin-equivalent."
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
                    "blog_agent": "블로그 에이전트 위임",
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
                        "description": "블로그 SDK 가 사용할 모델 ID",
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
            ConfigField(
                name="base_url",
                field_type=FieldType.URL,
                label="Base URL",
                description="블로그 외부 API base URL",
                placeholder="https://hrletsgo.me",
                group="blog_agent",
                apply_change=env_sync("BLOG_AGENT_BASE_URL"),
            ),
            ConfigField(
                name="api_key",
                field_type=FieldType.PASSWORD,
                label="API Key",
                description="블로그 외부 API Bearer 토큰 (admin 비밀번호 무게)",
                placeholder="32-hex-chars",
                group="blog_agent",
                secure=True,
                apply_change=env_sync("BLOG_AGENT_API_KEY"),
            ),
            ConfigField(
                name="default_model",
                field_type=FieldType.STRING,
                label="기본 모델",
                description="블로그 SDK 가 사용할 모델 ID",
                placeholder="claude-sonnet-4-6",
                group="blog_agent",
                apply_change=env_sync("BLOG_AGENT_DEFAULT_MODEL"),
            ),
            ConfigField(
                name="default_timeout_s",
                field_type=FieldType.NUMBER,
                label="Stream 타임아웃 (초)",
                description="한 위임 turn 의 최대 SSE 수신 시간",
                group="blog_agent",
                min_value=30.0,
                max_value=3600.0,
                apply_change=env_sync("BLOG_AGENT_DEFAULT_TIMEOUT_S"),
            ),
            ConfigField(
                name="pump_idle_grace_s",
                field_type=FieldType.NUMBER,
                label="Idle 허용 시간 (초)",
                description="SSE frame 이 N초 이상 안 오면 transient 경고",
                group="blog_agent",
                min_value=5.0,
                max_value=600.0,
                apply_change=env_sync("BLOG_AGENT_PUMP_IDLE_GRACE_S"),
            ),
            ConfigField(
                name="enabled",
                field_type=FieldType.BOOLEAN,
                label="활성화",
                description="OFF면 blog_agent_* 도구가 명시적 에러를 반환",
                group="blog_agent",
                apply_change=env_sync("BLOG_AGENT_ENABLED"),
            ),
            ConfigField(
                name="enabled_for_subworkers",
                field_type=FieldType.BOOLEAN,
                label="Sub-Worker 노출",
                description=(
                    "기본 OFF. ON 으로 바꿔도 Worker env template 이 자동 갱신되지 "
                    "않으므로 별도 env 편집이 필요."
                ),
                group="blog_agent",
                apply_change=env_sync("BLOG_AGENT_ENABLED_FOR_SUBWORKERS"),
            ),
            ConfigField(
                name="max_concurrent_per_session",
                field_type=FieldType.NUMBER,
                label="세션당 동시 위임 상한",
                description="한 Geny 세션이 동시에 진행할 수 있는 위임 task 수",
                group="blog_agent",
                min_value=1,
                max_value=10,
                apply_change=env_sync("BLOG_AGENT_MAX_CONCURRENT_PER_SESSION"),
            ),
        ]
