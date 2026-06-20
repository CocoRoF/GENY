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

    @classmethod
    def get_setup_guide(cls) -> Dict[str, str]:
        return {"ko": _GUIDE_KO, "en": _GUIDE_EN}


_GUIDE_KO = """\
# 슬랙 봇 연결 방법 (Socket Mode)

공개 서버 없이 동작해요. 토큰이 **두 개** 필요합니다 — 앱 토큰(`xapp-`)과 봇 토큰(`xoxb-`).

## 1. 앱 만들기
<https://api.slack.com/apps> → **Create New App** → *From scratch* → 워크스페이스 선택.

## 2. Socket Mode 켜기 + 앱 토큰(xapp-)
1. 좌측 **Socket Mode** → **Enable Socket Mode** 를 켜요.
2. 그 과정에서 **App-Level Token** 을 만들어요(스코프 `connections:write`) → 토큰(`xapp-...`) **복사**.

## 3. 봇 토큰(xoxb-) + 권한
1. **OAuth & Permissions** → **Scopes → Bot Token Scopes** 에 **`chat:write`** 추가.
2. 페이지 위쪽 **Install to Workspace** → 설치 → **Bot User OAuth Token**(`xoxb-...`) **복사**.

## 4. 메시지 이벤트 구독
1. **Event Subscriptions** → **Enable Events** 켜기.
2. **Subscribe to bot events** 에 **`message.channels`** 추가(DM도 받으려면 `message.im`) → 저장.
3. 권한/이벤트 변경 후 *재설치* 안내가 뜨면 다시 **Install** 해요.

## 5. Geny에 연결
1. 이 카드에서 **슬랙 연동 사용** 켜기.
2. **App-Level 토큰(xapp-)** 과 **봇 토큰(xoxb-)** 을 붙여넣어요.
3. *(선택)* 허용 채널 ID.
4. **저장** → 자동 연결. 채널에서 **`/invite @봇이름`** 으로 봇을 초대한 뒤 말을 걸어보세요.

> 전제: **설정 → LLM 백엔드**에 모델이 설정돼 있어야 답합니다.
"""

_GUIDE_EN = """\
# Connect a Slack bot (Socket Mode)

No public endpoint needed. You need **two** tokens — an app-level token
(`xapp-`) and a bot token (`xoxb-`).

## 1. Create an app
<https://api.slack.com/apps> → **Create New App** → *From scratch*.

## 2. Socket Mode + app token
Left menu **Socket Mode** → enable it → create an **App-Level Token**
(`connections:write`) → copy `xapp-…`.

## 3. Bot token + scope
**OAuth & Permissions** → add the **`chat:write`** Bot Token Scope → **Install to
Workspace** → copy the **Bot User OAuth Token** `xoxb-…`.

## 4. Subscribe to message events
**Event Subscriptions** → enable → add bot events **`message.channels`** (and
`message.im` for DMs) → save → reinstall if prompted.

## 5. Connect to Geny
Enable Slack here, paste both tokens, optionally restrict channels, **Save**.
Invite the bot to a channel (`/invite @bot`) and message it.

> Requires an LLM backend configured under Settings → LLM Backends.
"""
