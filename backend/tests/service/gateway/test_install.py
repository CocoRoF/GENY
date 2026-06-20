"""Gateway spec loading + runner construction (Geny consumer side)."""

from __future__ import annotations

from unittest.mock import patch

import pytest

pytest.importorskip("geny_executor.gateway")

from service.gateway.install import _specs_from_env, load_gateway_specs


def test_env_no_token_no_specs():
    with patch.dict("os.environ", {"GATEWAY_TELEGRAM_BOT_TOKEN": ""}, clear=False):
        assert _specs_from_env() == []


def test_env_token_builds_telegram_spec():
    with patch.dict(
        "os.environ",
        {"GATEWAY_TELEGRAM_BOT_TOKEN": "123:abc", "GATEWAY_TELEGRAM_ALLOWED_CHAT_IDS": ""},
        clear=False,
    ):
        specs = _specs_from_env()
    assert specs == [{"platform": "telegram", "config": {"token": "123:abc"}}]


def test_env_discord_spec():
    with patch.dict(
        "os.environ",
        {"GATEWAY_TELEGRAM_BOT_TOKEN": "", "GATEWAY_DISCORD_BOT_TOKEN": "botT"},
        clear=False,
    ):
        specs = _specs_from_env()
    assert specs == [{"platform": "discord", "config": {"token": "botT"}}]


def test_env_slack_needs_both_tokens():
    # only the app token → no spec
    with patch.dict(
        "os.environ",
        {
            "GATEWAY_TELEGRAM_BOT_TOKEN": "",
            "GATEWAY_DISCORD_BOT_TOKEN": "",
            "GATEWAY_SLACK_APP_TOKEN": "xapp",
            "GATEWAY_SLACK_BOT_TOKEN": "",
        },
        clear=False,
    ):
        assert _specs_from_env() == []
    with patch.dict(
        "os.environ",
        {
            "GATEWAY_TELEGRAM_BOT_TOKEN": "",
            "GATEWAY_DISCORD_BOT_TOKEN": "",
            "GATEWAY_SLACK_APP_TOKEN": "xapp",
            "GATEWAY_SLACK_BOT_TOKEN": "xoxb",
        },
        clear=False,
    ):
        specs = _specs_from_env()
    assert specs == [
        {"platform": "slack", "config": {"app_token": "xapp", "bot_token": "xoxb"}}
    ]


def test_env_allowed_chat_ids_parsed():
    with patch.dict(
        "os.environ",
        {
            "GATEWAY_TELEGRAM_BOT_TOKEN": "123:abc",
            "GATEWAY_TELEGRAM_ALLOWED_CHAT_IDS": "555, 777 ,",
        },
        clear=False,
    ):
        specs = _specs_from_env()
    assert specs[0]["config"]["allowed_chat_ids"] == ["555", "777"]


def test_runner_builds_with_geny_handler():
    """End-to-end (no network): env spec → executor build_gateway → a telegram
    adapter wired to Geny's handle_inbound."""
    from geny_executor.gateway import build_gateway

    from service.gateway.handler import handle_inbound

    with patch.dict("os.environ", {"GATEWAY_TELEGRAM_BOT_TOKEN": "123:abc"}, clear=False):
        runner = build_gateway(load_gateway_specs(), handle_inbound)
    assert [a.name for a in runner.adapters] == ["telegram"]


def test_specs_from_geny_config_when_enabled():
    """Enabling Telegram/Discord/Slack in the Geny config UI yields gateway
    specs (the primary, UI-driven source)."""
    from service.config.sub_config.channels.discord_config import DiscordConfig
    from service.config.sub_config.channels.slack_config import SlackConfig
    from service.config.sub_config.channels.telegram_config import TelegramConfig
    from service.gateway import install as gw_install

    instances = {
        TelegramConfig: TelegramConfig(enabled=True, bot_token="123:abc", allowed_chat_ids=["5"]),
        DiscordConfig: DiscordConfig(enabled=True, bot_token="botT"),
        SlackConfig: SlackConfig(enabled=False),  # off → not included
    }

    class _CM:
        def load_config(self, cls):
            return instances.get(cls, cls())

    with patch("service.config.get_config_manager", lambda: _CM()):
        specs = gw_install._specs_from_geny_config()

    platforms = {s["platform"] for s in specs}
    assert platforms == {"telegram", "discord"}  # slack off
    tg = next(s for s in specs if s["platform"] == "telegram")
    assert tg["config"] == {"token": "123:abc", "allowed_chat_ids": ["5"]}


def test_disabled_channel_config_has_no_validation_problems():
    """A disabled integration reports no problems (fixes the false 'N개 문제')."""
    from service.config.sub_config.channels.discord_config import DiscordConfig
    from service.config.sub_config.channels.kakao_config import KakaoConfig

    assert DiscordConfig(enabled=False).validate() == []
    assert KakaoConfig(enabled=False).validate() == []
    # enabled but missing token → a real, surfaced problem
    assert DiscordConfig(enabled=True).validate()


def test_settings_section_registered():
    """The ``gateway`` settings section schema exists + validates."""
    from service.settings.sections import GatewayConfigSection

    parsed = GatewayConfigSection.model_validate(
        {"platforms": [{"platform": "telegram", "config": {"token": "x"}}]}
    )
    assert parsed.platforms[0].platform == "telegram"
