"""
OpenAI TTS Configuration.

Settings for OpenAI's TTS API (tts-1, tts-1-hd models).
Requires an OpenAI API key.
"""

from dataclasses import dataclass
from typing import Any, Dict, List

from service.config.base import BaseConfig, ConfigField, FieldType, register_config


@register_config
@dataclass
class OpenAITTSConfig(BaseConfig):
    """OpenAI TTS settings"""

    api_key: str = ""
    model: str = "tts-1"
    voice: str = "nova"

    @classmethod
    def get_config_name(cls) -> str:
        return "tts_openai"

    @classmethod
    def get_display_name(cls) -> str:
        return "OpenAI TTS"

    @classmethod
    def get_description(cls) -> str:
        return "OpenAI TTS API — tts-1 (fast), tts-1-hd (high quality)"

    @classmethod
    def get_category(cls) -> str:
        return "tts"

    @classmethod
    def get_icon(cls) -> str:
        return "openai"

    @classmethod
    def get_fields_metadata(cls) -> List[ConfigField]:
        return [
            ConfigField(
                name="api_key",
                field_type=FieldType.PASSWORD,
                label="API Key",
                group="auth",
                placeholder="sk-...",
                secure=True,
            ),
            ConfigField(
                name="model",
                field_type=FieldType.SELECT,
                label="Model",
                group="voice",
                options=[
                    {"value": "tts-1", "label": "tts-1 (Fast, Low Cost)"},
                    {"value": "tts-1-hd", "label": "tts-1-hd (High Quality)"},
                ],
            ),
            ConfigField(
                name="voice",
                field_type=FieldType.SELECT,
                label="Voice",
                group="voice",
                options=[
                    {"value": "alloy", "label": "Alloy"},
                    {"value": "ash", "label": "Ash"},
                    {"value": "coral", "label": "Coral"},
                    {"value": "echo", "label": "Echo"},
                    {"value": "fable", "label": "Fable"},
                    {"value": "nova", "label": "Nova"},
                    {"value": "onyx", "label": "Onyx"},
                    {"value": "sage", "label": "Sage"},
                    {"value": "shimmer", "label": "Shimmer"},
                ],
            ),
        ]

    @classmethod
    def get_i18n(cls) -> Dict[str, Dict[str, Any]]:
        return {
            "ko": {
                "display_name": "OpenAI TTS",
                "description": "OpenAI TTS API — tts-1 (빠름), tts-1-hd (고품질)",
                "groups": {
                    "auth": "인증",
                    "voice": "음성",
                },
                "fields": {
                    "api_key": {
                        "label": "API Key",
                    },
                    "model": {
                        "label": "모델",
                    },
                    "voice": {
                        "label": "보이스",
                    },
                },
            },
            "en": {
                "display_name": "OpenAI TTS",
                "description": "OpenAI TTS API — tts-1 (fast), tts-1-hd (high quality)",
                "groups": {
                    "auth": "Authentication",
                    "voice": "Voice",
                },
            },
        }
