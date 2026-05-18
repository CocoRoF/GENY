"""LLM provider credentials — hidden from the generic SettingsTab.

Phase H of the LLM backend upgrade cycle. Splits the four credential
fields (Anthropic / OpenAI / Google API keys + vLLM base URL) out of
``APIConfig`` so the **only** user-facing editor for them is the LLM
Backends panel's ``ApiBackendModal``. The general 전체설정 list never
surfaces these — the config opts out via ``is_user_visible() = False``
but ``GET`` / ``PUT /api/config/llm_credentials`` still work so the
modal can read + write through the standard config controller.

The executor's ``CredentialBundleBuilder`` reads this config (not
``APIConfig``) when assembling the per-session ``CredentialBundle``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List

from service.config.base import BaseConfig, ConfigField, FieldType, register_config
from service.config.sub_config.general.env_utils import env_sync, read_env_defaults


@register_config
@dataclass
class LLMCredentialsConfig(BaseConfig):
    """API credentials for the four SDK-based LLM providers."""

    anthropic_api_key: str = ""
    openai_api_key: str = ""
    google_api_key: str = ""
    base_url: str = ""

    _ENV_MAP = {
        "anthropic_api_key": "ANTHROPIC_API_KEY",
        "openai_api_key": "OPENAI_API_KEY",
        "google_api_key": "GOOGLE_API_KEY",
        "base_url": "LLM_BASE_URL",
    }

    @classmethod
    def get_default_instance(cls) -> "LLMCredentialsConfig":
        defaults = read_env_defaults(cls._ENV_MAP, cls.__dataclass_fields__)
        return cls(**defaults)

    @classmethod
    def get_config_name(cls) -> str:
        return "llm_credentials"

    @classmethod
    def get_display_name(cls) -> str:
        return "LLM Credentials"

    @classmethod
    def get_description(cls) -> str:
        return (
            "API keys + base URL for the four SDK-based LLM providers. "
            "Edited through the LLM Backends panel's per-provider modal."
        )

    @classmethod
    def get_category(cls) -> str:
        return "general"

    @classmethod
    def get_icon(cls) -> str:
        return "key"

    @classmethod
    def is_user_visible(cls) -> bool:
        return False

    @classmethod
    def get_fields_metadata(cls) -> List[ConfigField]:
        return [
            ConfigField(
                name="anthropic_api_key",
                field_type=FieldType.PASSWORD,
                label="Anthropic API Key",
                description="API key for the Anthropic provider.",
                placeholder="sk-ant-…",
                group="credentials",
                secure=True,
                apply_change=env_sync("ANTHROPIC_API_KEY"),
            ),
            ConfigField(
                name="openai_api_key",
                field_type=FieldType.PASSWORD,
                label="OpenAI API Key",
                description="API key for the OpenAI provider (and vLLM if it requires one).",
                placeholder="sk-…",
                group="credentials",
                secure=True,
                apply_change=env_sync("OPENAI_API_KEY"),
            ),
            ConfigField(
                name="google_api_key",
                field_type=FieldType.PASSWORD,
                label="Google API Key",
                description="API key for the Google Gemini provider.",
                placeholder="AIza…",
                group="credentials",
                secure=True,
                apply_change=env_sync("GOOGLE_API_KEY"),
            ),
            ConfigField(
                name="base_url",
                field_type=FieldType.STRING,
                label="Base URL (vLLM)",
                description="OpenAI-compatible endpoint for the vLLM provider.",
                placeholder="http://host:8000/v1",
                group="credentials",
                apply_change=env_sync("LLM_BASE_URL"),
            ),
        ]
