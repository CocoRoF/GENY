"""
ElevenLabs Configuration.

Settings for ElevenLabs' high-quality voice synthesis API
with voice cloning and emotion control capabilities.
"""

from dataclasses import dataclass
from typing import Any, Dict, List

from service.config.base import BaseConfig, ConfigField, FieldType, register_config


@register_config
@dataclass
class ElevenLabsConfig(BaseConfig):
    """ElevenLabs TTS settings"""

    api_key: str = ""
    voice_id: str = ""
    model_id: str = "eleven_multilingual_v2"
    stability: float = 0.5
    similarity_boost: float = 0.75
    style: float = 0.0

    @classmethod
    def get_config_name(cls) -> str:
        return "tts_elevenlabs"

    @classmethod
    def get_display_name(cls) -> str:
        return "ElevenLabs"

    @classmethod
    def get_description(cls) -> str:
        return "High-quality voice cloning + emotion — multilingual support"

    @classmethod
    def get_category(cls) -> str:
        return "tts"

    @classmethod
    def get_icon(cls) -> str:
        return "mic"

    @classmethod
    def get_fields_metadata(cls) -> List[ConfigField]:
        return [
            ConfigField(
                name="api_key",
                field_type=FieldType.PASSWORD,
                label="API Key",
                group="auth",
                placeholder="xi-...",
                secure=True,
            ),
            ConfigField(
                name="voice_id",
                field_type=FieldType.STRING,
                label="Voice ID",
                description="Voice ID created in ElevenLabs Voice Lab",
                group="voice",
            ),
            ConfigField(
                name="model_id",
                field_type=FieldType.SELECT,
                label="Model",
                group="voice",
                options=[
                    {"value": "eleven_multilingual_v2", "label": "Multilingual v2"},
                    {"value": "eleven_turbo_v2_5", "label": "Turbo v2.5 (Fast)"},
                    {"value": "eleven_monolingual_v1", "label": "Monolingual v1 (English)"},
                ],
            ),
            ConfigField(
                name="stability",
                field_type=FieldType.NUMBER,
                label="Stability",
                description="Higher = more stable, lower = more expressive",
                group="voice_settings",
                min_value=0.0,
                max_value=1.0,
            ),
            ConfigField(
                name="similarity_boost",
                field_type=FieldType.NUMBER,
                label="Similarity Boost",
                group="voice_settings",
                min_value=0.0,
                max_value=1.0,
            ),
            ConfigField(
                name="style",
                field_type=FieldType.NUMBER,
                label="Style Exaggeration",
                description="Degree of emotion/style exaggeration",
                group="voice_settings",
                min_value=0.0,
                max_value=1.0,
            ),
        ]

    @classmethod
    def get_i18n(cls) -> Dict[str, Dict[str, Any]]:
        return {
            "ko": {
                "display_name": "ElevenLabs",
                "description": "고품질 음성 클로닝 + 감정 표현 — 다국어 지원",
                "groups": {
                    "auth": "인증",
                    "voice": "음성",
                    "voice_settings": "보이스 설정",
                },
                "fields": {
                    "api_key": {
                        "label": "API Key",
                    },
                    "voice_id": {
                        "label": "Voice ID",
                        "description": "ElevenLabs Voice Lab에서 생성한 보이스 ID",
                    },
                    "model_id": {
                        "label": "모델",
                    },
                    "stability": {
                        "label": "Stability",
                        "description": "높을수록 안정적, 낮을수록 감정 표현 풍부",
                    },
                    "similarity_boost": {
                        "label": "Similarity Boost",
                    },
                    "style": {
                        "label": "Style Exaggeration",
                        "description": "감정/스타일 과장 정도",
                    },
                },
            },
            "en": {
                "display_name": "ElevenLabs",
                "description": "High-quality voice cloning + emotion — multilingual",
                "groups": {
                    "auth": "Authentication",
                    "voice": "Voice",
                    "voice_settings": "Voice Settings",
                },
            },
        }
