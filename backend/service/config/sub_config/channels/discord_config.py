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

    @classmethod
    def get_setup_guide(cls) -> Dict[str, str]:
        return {"ko": _GUIDE_KO, "en": _GUIDE_EN}


_GUIDE_KO = """\
# Discord 봇 연결 방법

봇을 **만들고 → 서버에 초대 → 여기 토큰 입력**, 3단계예요. 공개 서버 없이 동작합니다.

## 1. 봇 만들기
1. <https://discord.com/developers/applications> 접속 → **New Application** → 이름 입력 → **Create**.
2. 왼쪽 메뉴 **Bot** 클릭. (봇이 없으면 *Add Bot*)

## 2. ⚠️ Message Content Intent 켜기 (필수!)
**Bot** 페이지를 아래로 스크롤 → **Privileged Gateway Intents** 에서
- **Message Content Intent** 를 **켜세요(ON)**. ← 꺼져 있으면 봇이 메시지 **내용을 빈 값**으로 받아 답을 못 합니다.
- `Presence Intent` / `Server Members Intent` 는 **켤 필요 없어요**.

## 3. 토큰 받기
같은 **Bot** 페이지의 **Token** → **Reset Token(토큰 초기화)** → 표시된 토큰을 **복사**.
> 토큰은 **딱 한 번만** 보여요. 잃어버리면 다시 *Reset*.

## 4. 봇을 서버에 초대 — 가장 헷갈리는 단계
> ❗ 봇은 "친구 초대" 창이나 서버 초대 링크(discord.gg/...)로는 **못 들어갑니다.** 아래 **전용 링크**로 초대해요.

1. 왼쪽 메뉴 **OAuth2** → 아래로 스크롤 → **OAuth2 URL Generator**.
2. **SCOPES** 목록에서 **`bot`** 체크.
3. 그러면 바로 아래에 **BOT PERMISSIONS** 가 나타나요 → 다음 3개 체크:
   - **View Channels**
   - **Send Messages**
   - **Read Message History**
4. 맨 아래 **GENERATED URL** 의 **Copy** 버튼 클릭.
5. 복사한 URL을 **브라우저 주소창에 붙여넣고 이동** → **내 서버 선택** → **승인(Authorize)** → 캡차.
6. 디스코드 앱의 서버 **멤버 목록**에 봇이 보이면 성공! (처음엔 **오프라인=정상**)

## 5. Geny에 연결
1. 이 카드에서 **Discord 연동 사용**을 켜요.
2. **봇 토큰**에 3번에서 복사한 토큰을 붙여넣어요.
3. *(선택)* **허용 채널 ID** — 특정 채널만 응답하게 하려면 입력. 비우면 봇이 보는 모든 채널.
4. **저장** → 게이트웨이가 **자동 연결**돼요(백엔드 재시작 불필요). 봇이 **온라인(초록불)** 이 되면 채널에 말을 걸어보세요.

> 전제: **설정 → LLM 백엔드**에 모델이 하나라도 설정돼 있어야 답합니다(Ollama 또는 클라우드 키).
"""

_GUIDE_EN = """\
# Connect a Discord bot

Three steps: **create a bot → invite it to your server → paste the token here.**
No public server needed.

## 1. Create the bot
1. Go to <https://discord.com/developers/applications> → **New Application** → name it → **Create**.
2. Left menu **Bot** (add a bot if prompted).

## 2. ⚠️ Enable the Message Content Intent (required!)
On the **Bot** page scroll to **Privileged Gateway Intents** and turn **Message
Content Intent ON**. Without it the bot receives empty message text and can't
reply. Presence / Server Members are not needed.

## 3. Get the token
**Bot** page → **Token** → **Reset Token** → copy the shown token (shown once).

## 4. Invite the bot to your server
> A bot can't join via the "invite friends" dialog or a discord.gg link — use the generated link below.

1. Left menu **OAuth2** → **OAuth2 URL Generator**.
2. Under **SCOPES** check **`bot`**.
3. In the **BOT PERMISSIONS** that appear, check **View Channels**, **Send Messages**, **Read Message History**.
4. Copy the **GENERATED URL** at the bottom.
5. Open it in your browser → pick your server → **Authorize**.

## 5. Connect to Geny
Enable Discord here, paste the **Bot Token**, optionally restrict **Allowed
Channel IDs**, and **Save** — the gateway connects automatically (no restart).
The bot goes online (green) and replies in channels it can see.

> Requires an LLM backend configured under Settings → LLM Backends.
"""
