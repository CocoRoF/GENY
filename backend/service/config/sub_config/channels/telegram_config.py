"""Telegram bot channel — drives the geny-executor inbound gateway.

Enable + paste a @BotFather token and the backend starts a Telegram gateway:
each chat becomes a persistent VTuber session. No public endpoint needed
(the executor long-polls the Bot API).
"""

from dataclasses import dataclass, field
from typing import Any, Dict, List

from service.config.base import BaseConfig, ConfigField, FieldType, register_config


@register_config
@dataclass
class TelegramConfig(BaseConfig):
    """Telegram bot integration (inbound gateway)."""

    enabled: bool = False
    bot_token: str = ""
    allowed_chat_ids: List[str] = field(default_factory=list)

    @classmethod
    def get_config_name(cls) -> str:
        return "telegram"

    @classmethod
    def get_display_name(cls) -> str:
        return "Telegram"

    @classmethod
    def get_description(cls) -> str:
        return (
            "Let users talk to your VTuber from Telegram. Create a bot with "
            "@BotFather, paste its token, and enable — the backend connects "
            "automatically (no public server needed). Each chat is a persistent "
            "session."
        )

    @classmethod
    def get_category(cls) -> str:
        return "channels"

    @classmethod
    def get_icon(cls) -> str:
        return "send"

    @classmethod
    def get_i18n(cls) -> Dict[str, Dict[str, Any]]:
        return {
            "ko": {
                "display_name": "텔레그램",
                "description": (
                    "텔레그램에서 VTuber와 대화하게 합니다. @BotFather로 봇을 만들어 "
                    "토큰을 붙여넣고 활성화하면 백엔드가 자동 연결돼요(공개 서버 불필요). "
                    "대화방마다 독립 세션이 유지됩니다."
                ),
                "fields": {
                    "enabled": {
                        "label": "텔레그램 연동 사용",
                        "description": "켜면 봇이 메시지를 받기 시작합니다.",
                    },
                    "bot_token": {
                        "label": "봇 토큰",
                        "description": (
                            "@BotFather에서 /newbot 으로 봇을 만들고 받은 토큰 "
                            "(123456:ABC-DEF... 형태)."
                        ),
                    },
                    "allowed_chat_ids": {
                        "label": "허용 채팅 ID (선택)",
                        "description": (
                            "쉼표로 구분한 채팅 ID 목록. 비우면 누구나 사용 가능. "
                            "본인 chat id 는 봇에게 아무 메시지나 보낸 뒤 "
                            "@userinfobot 등으로 확인할 수 있어요."
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
                label="Enable Telegram",
                description="Start receiving messages when on.",
                default=False,
                group="connection",
            ),
            ConfigField(
                name="bot_token",
                field_type=FieldType.PASSWORD,
                label="Bot Token",
                description="The token @BotFather gave you (123456:ABC-DEF…).",
                required=True,
                placeholder="123456:ABC-DEF...",
                group="connection",
                secure=True,
            ),
            ConfigField(
                name="allowed_chat_ids",
                field_type=FieldType.TEXTAREA,
                label="Allowed Chat IDs (optional)",
                description="Comma-separated chat ids. Empty = anyone may DM the bot.",
                placeholder="12345678, 87654321",
                group="connection",
            ),
        ]

    def validate(self) -> List[str]:
        # A disabled integration has nothing to validate (so the card shows no
        # spurious "required" problems). When enabled, run the normal checks.
        if not self.enabled:
            return []
        return super().validate()
