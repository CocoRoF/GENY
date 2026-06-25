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
from service.sync.provider_key_sync import synced_env


@register_config
@dataclass
class LLMCredentialsConfig(BaseConfig):
    """API credentials for the four SDK-based LLM providers."""

    anthropic_api_key: str = ""
    openai_api_key: str = ""
    google_api_key: str = ""
    base_url: str = ""

    # Branded local (OpenAI-compatible) backends — executor 2.9.0
    # ProviderProfile layer. A non-empty base_url marks the provider as
    # configured (CredentialBundleBuilder emits it; the LLM Backends panel
    # surfaces it as a card with model discovery). ``ollama_num_ctx`` is
    # the context window the model is loaded with (0 = let the server /
    # the executor's /api/show probe decide).
    ollama_base_url: str = ""
    lmstudio_base_url: str = ""
    custom_base_url: str = ""
    ollama_num_ctx: int = 0

    # field → env var, so a fresh install (no saved config yet) seeds
    # defaults from the environment. Previously absent — ``get_default_instance``
    # referenced ``cls._ENV_MAP`` with nothing defining it, so the
    # first-run default path raised ``AttributeError`` (only reachable
    # before any saved llm_credentials file exists). Mirrors the
    # ``apply_change=env_sync(...)`` write-side mappings below.
    _ENV_MAP = {
        "anthropic_api_key": "ANTHROPIC_API_KEY",
        "openai_api_key": "OPENAI_API_KEY",
        "google_api_key": "GOOGLE_API_KEY",
        "base_url": "LLM_BASE_URL",
        "ollama_base_url": "OLLAMA_BASE_URL",
        "ollama_num_ctx": "OLLAMA_NUM_CTX",
        "lmstudio_base_url": "LMSTUDIO_BASE_URL",
        "custom_base_url": "CUSTOM_LLM_BASE_URL",
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
                # synced_env = env_sync + propagate to GAPT vault (provider:anthropic)
                apply_change=synced_env("ANTHROPIC_API_KEY"),
            ),
            ConfigField(
                name="openai_api_key",
                field_type=FieldType.PASSWORD,
                label="OpenAI API Key",
                description="API key for the OpenAI provider (and vLLM if it requires one).",
                placeholder="sk-…",
                group="credentials",
                secure=True,
                # → GAPT vault (openai) + avatar config.json (id:openai)
                apply_change=synced_env("OPENAI_API_KEY"),
            ),
            ConfigField(
                name="google_api_key",
                field_type=FieldType.PASSWORD,
                label="Google API Key",
                description="API key for the Google Gemini provider.",
                placeholder="AIza…",
                group="credentials",
                secure=True,
                # → GAPT vault (google) + avatar config.json (id:gemini)
                apply_change=synced_env("GOOGLE_API_KEY"),
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
            ConfigField(
                name="ollama_base_url",
                field_type=FieldType.STRING,
                label="Ollama Base URL",
                description="Ollama's OpenAI-compatible endpoint. Leave the default for a local install.",
                placeholder="http://localhost:11434/v1",
                group="local_models",
                apply_change=env_sync("OLLAMA_BASE_URL"),
            ),
            ConfigField(
                name="ollama_num_ctx",
                field_type=FieldType.NUMBER,
                label="Ollama Context Window",
                description="Context window the model is loaded with (tokens). 0 = auto-detect via /api/show.",
                placeholder="0",
                group="local_models",
                min_value=0,
                apply_change=env_sync("OLLAMA_NUM_CTX"),
            ),
            ConfigField(
                name="lmstudio_base_url",
                field_type=FieldType.STRING,
                label="LM Studio Base URL",
                description="LM Studio's local server endpoint. Leave the default for a local install.",
                placeholder="http://127.0.0.1:1234/v1",
                group="local_models",
                apply_change=env_sync("LMSTUDIO_BASE_URL"),
            ),
            ConfigField(
                name="custom_base_url",
                field_type=FieldType.STRING,
                label="Custom OpenAI-compatible Base URL",
                description="Any other OpenAI-compatible endpoint (llama.cpp server, LiteLLM, …).",
                placeholder="http://localhost:8080/v1",
                group="local_models",
                apply_change=env_sync("CUSTOM_LLM_BASE_URL"),
            ),
        ]
