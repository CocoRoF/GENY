"""Discord bot channel — drives the geny-executor inbound gateway.

Enable + paste a bot token and the backend connects to the Discord Gateway
(WebSocket): every message the bot can see becomes a VTuber turn, replied in
the same channel. No public endpoint needed. You MUST enable the privileged
**Message Content Intent** in the Developer Portal or the bot sees empty text.
"""

from dataclasses import dataclass, field
from typing import Any, Dict, List

from service.config.base import BaseConfig, ConfigField, FieldType, register_config


@register_config
@dataclass
class DiscordConfig(BaseConfig):
    """Discord bot integration (inbound gateway)."""

    enabled: bool = False
    bot_token: str = ""
    allowed_channel_ids: List[str] = field(default_factory=list)

    @classmethod
    def get_config_name(cls) -> str:
        return "discord"

    @classmethod
    def get_display_name(cls) -> str:
        return "Discord"

    @classmethod
    def get_description(cls) -> str:
        return (
            "Let users talk to your VTuber from Discord. Create a bot at "
            "discord.com/developers, enable the Message Content Intent, invite "
            "it to your server, and paste its token. The backend connects over "
            "the Gateway WebSocket — no public server needed."
        )

    @classmethod
    def get_category(cls) -> str:
        return "channels"

    @classmethod
    def get_icon(cls) -> str:
        return "discord"

    @classmethod
    def get_i18n(cls) -> Dict[str, Dict[str, Any]]:
        return {
            "ko": {
                "display_name": "디스코드",
                "description": (
                    "디스코드에서 VTuber와 대화하게 합니다. discord.com/developers "
                    "에서 봇을 만들고 ‘Message Content Intent’를 켠 뒤 서버에 초대하고 "
                    "토큰을 붙여넣으세요. 백엔드가 Gateway WebSocket으로 자동 연결돼요"
                    "(공개 서버 불필요)."
                ),
                "fields": {
                    "enabled": {
                        "label": "디스코드 연동 사용",
                        "description": "켜면 봇이 메시지를 받기 시작합니다.",
                    },
                    "bot_token": {
                        "label": "봇 토큰",
                        "description": (
                            "Developer Portal → 앱 → Bot → Token. ⚠️ 같은 화면의 "
                            "Privileged Gateway Intents에서 ‘Message Content Intent’를 "
                            "반드시 켜야 메시지 내용을 받을 수 있어요."
                        ),
                    },
                    "allowed_channel_ids": {
                        "label": "허용 채널 ID (선택)",
                        "description": (
                            "쉼표로 구분한 채널 ID 목록. 비우면 봇이 보는 모든 채널에 응답. "
                            "채널 ID는 개발자 모드를 켠 뒤 채널 우클릭 → ‘ID 복사’."
                        ),
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
                label="Enable Discord",
                description="Start receiving messages when on.",
                default=False,
                group="connection",
            ),
            ConfigField(
                name="bot_token",
                field_type=FieldType.PASSWORD,
                label="Bot Token",
                description=(
                    "Developer Portal → your app → Bot → Token. You MUST enable "
                    "the Message Content Intent on that page."
                ),
                required=True,
                placeholder="Enter your Discord bot token",
                group="connection",
                secure=True,
            ),
            ConfigField(
                name="allowed_channel_ids",
                field_type=FieldType.TEXTAREA,
                label="Allowed Channel IDs (optional)",
                description="Comma-separated channel ids. Empty = every channel the bot sees.",
                placeholder="123456789012345678, 987654321098765432",
                group="connection",
            ),
        ]

    def validate(self) -> List[str]:
        if not self.enabled:
            return []
        return super().validate()
