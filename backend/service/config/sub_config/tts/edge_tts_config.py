"""
Edge TTS Configuration.

Voice settings for the free Microsoft Edge TTS engine.
No API key required — uses Microsoft's Edge browser TTS service.
"""

from dataclasses import dataclass
from typing import Any, Dict, List

from service.config.base import BaseConfig, ConfigField, FieldType, register_config


@register_config
@dataclass
class EdgeTTSConfig(BaseConfig):
    """Edge TTS settings — free Microsoft TTS voice selection"""

    voice_ko: str = "ko-KR-SunHiNeural"
    voice_ja: str = "ja-JP-NanamiNeural"
    voice_en: str = "en-US-JennyNeural"

    @classmethod
    def get_config_name(cls) -> str:
        return "tts_edge"

    @classmethod
    def get_display_name(cls) -> str:
        return "Edge TTS"

    @classmethod
    def get_description(cls) -> str:
        return "Free Microsoft Edge TTS — no API key needed, fast response"

    @classmethod
    def get_category(cls) -> str:
        return "tts"

    @classmethod
    def get_icon(cls) -> str:
        return "free"

    @classmethod
    def get_fields_metadata(cls) -> List[ConfigField]:
        return [
            ConfigField(
                name="voice_ko",
                field_type=FieldType.SELECT,
                label="Korean Voice",
                group="voice",
                options=[
                    {"value": "ko-KR-SunHiNeural", "label": "SunHi (Female)"},
                    {"value": "ko-KR-InJoonNeural", "label": "InJoon (Male)"},
                    {"value": "ko-KR-BongJinNeural", "label": "BongJin (Male)"},
                    {"value": "ko-KR-YuJinNeural", "label": "YuJin (Female)"},
                ],
            ),
            ConfigField(
                name="voice_ja",
                field_type=FieldType.SELECT,
                label="Japanese Voice",
                group="voice",
                options=[
                    {"value": "ja-JP-NanamiNeural", "label": "Nanami (Female)"},
                    {"value": "ja-JP-KeitaNeural", "label": "Keita (Male)"},
                ],
            ),
            ConfigField(
                name="voice_en",
                field_type=FieldType.SELECT,
                label="English Voice",
                group="voice",
                options=[
                    {"value": "en-US-JennyNeural", "label": "Jenny (Female)"},
                    {"value": "en-US-GuyNeural", "label": "Guy (Male)"},
                    {"value": "en-US-AriaNeural", "label": "Aria (Female)"},
                ],
            ),
        ]

    @classmethod
    def get_i18n(cls) -> Dict[str, Dict[str, Any]]:
        return {
            "ko": {
                "display_name": "Edge TTS",
                "description": "무료 Microsoft Edge TTS — API 키 불필요, 빠른 응답",
                "groups": {
                    "voice": "보이스",
                },
                "fields": {
                    "voice_ko": {
                        "label": "한국어 보이스",
                    },
                    "voice_ja": {
                        "label": "일본어 보이스",
                    },
                    "voice_en": {
                        "label": "영어 보이스",
                    },
                },
            },
            "en": {
                "display_name": "Edge TTS",
                "description": "Free Microsoft Edge TTS — no API key, fast response",
                "groups": {
                    "voice": "Voice",
                },
            },
        }
