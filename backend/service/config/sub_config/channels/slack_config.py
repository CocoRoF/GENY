"""Slack bot channel — drives the geny-executor inbound gateway.

Uses Slack **Socket Mode** (no public endpoint): enable + paste an app-level
token (``xapp-…``) and a bot token (``xoxb-…``) and the backend opens a socket,
turns ``message`` events into VTuber turns, and replies via ``chat.postMessage``.
"""

from dataclasses import dataclass, field
from typing import Any, Dict, List

from service.config.base import BaseConfig, ConfigField, FieldType, register_config


@register_config
@dataclass
class SlackConfig(BaseConfig):
    """Slack bot integration (inbound gateway, Socket Mode)."""

    enabled: bool = False
    app_token: str = ""  # xapp-… (Socket Mode)
    bot_token: str = ""  # xoxb-… (Web API)
    allowed_channel_ids: List[str] = field(default_factory=list)

    @classmethod
    def get_config_name(cls) -> str:
        return "slack"

    @classmethod
    def get_display_name(cls) -> str:
        return "Slack"

    @classmethod
    def get_description(cls) -> str:
        return (
            "Let users talk to your VTuber from Slack via Socket Mode (no public "
            "server needed). Create a Slack app, enable Socket Mode, add an "
            "app-level token (xapp-) and a bot token (xoxb-) with chat:write, and "
            "subscribe to message events."
        )

    @classmethod
    def get_category(cls) -> str:
        return "channels"

    @classmethod
    def get_icon(cls) -> str:
        return "slack"

    @classmethod
    def get_i18n(cls) -> Dict[str, Dict[str, Any]]:
        return {
            "ko": {
                "display_name": "슬랙",
                "description": (
                    "슬랙에서 VTuber와 대화하게 합니다(Socket Mode, 공개 서버 불필요). "
                    "Slack 앱을 만들어 Socket Mode를 켜고, app-level 토큰(xapp-)과 "
                    "chat:write 권한의 봇 토큰(xoxb-)을 발급한 뒤, message 이벤트를 "
                    "구독하세요."
                ),
                "fields": {
                    "enabled": {
                        "label": "슬랙 연동 사용",
                        "description": "켜면 봇이 메시지를 받기 시작합니다.",
                    },
                    "app_token": {
                        "label": "App-Level 토큰 (xapp-)",
                        "description": (
                            "Slack 앱 → Basic Information → App-Level Tokens에서 "
                            "connections:write 스코프로 발급. Socket Mode 연결에 사용돼요."
                        ),
                    },
                    "bot_token": {
                        "label": "봇 토큰 (xoxb-)",
                        "description": (
                            "OAuth & Permissions → Bot User OAuth Token. chat:write "
                            "스코프가 필요하고 답장 전송에 사용돼요."
                        ),
                    },
                    "allowed_channel_ids": {
                        "label": "허용 채널 ID (선택)",
                        "description": "쉼표로 구분한 채널 ID 목록. 비우면 모든 채널에 응답.",
                    },
                },
            }
        }

    @classmethod
    def get_fields_metadata(cls) -> List[ConfigField]:
        return [
            ConfigField(
                name="enabled",
                field_type=FieldType.BOOLEAN,
                label="Enable Slack",
                description="Start receiving messages when on.",
                default=False,
                group="connection",
            ),
            ConfigField(
                name="app_token",
                field_type=FieldType.PASSWORD,
                label="App-Level Token (xapp-)",
                description="Basic Information → App-Level Tokens (connections:write). For Socket Mode.",
                required=True,
                placeholder="xapp-...",
                group="connection",
                secure=True,
            ),
            ConfigField(
                name="bot_token",
                field_type=FieldType.PASSWORD,
                label="Bot Token (xoxb-)",
                description="OAuth & Permissions → Bot User OAuth Token (chat:write). For replies.",
                required=True,
                placeholder="xoxb-...",
                group="connection",
                secure=True,
            ),
            ConfigField(
                name="allowed_channel_ids",
                field_type=FieldType.TEXTAREA,
                label="Allowed Channel IDs (optional)",
                description="Comma-separated channel ids. Empty = all channels.",
                placeholder="C0123456789",
                group="connection",
            ),
        ]

    def validate(self) -> List[str]:
        if not self.enabled:
            return []
        return super().validate()
