"""Build + start the inbound gateway from Geny config.

Two config sources (both optional, unioned):

  1. **Env** — the easy path. ``GATEWAY_TELEGRAM_BOT_TOKEN`` (+ optional
     ``GATEWAY_TELEGRAM_ALLOWED_CHAT_IDS`` as a comma list) starts a Telegram
     gateway. Set it, restart, DM your bot.
  2. **settings.json ``gateway.platforms``** — richer, multi-platform:
     ``[{"platform": "telegram", "config": {"token": "…", "allowed_chat_ids": [...]}}]``.

The actual transport + loop live in geny-executor (``build_gateway``); this
module only assembles the specs and wires the handler.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


def _csv(name: str) -> List[str]:
    raw = (os.environ.get(name) or "").strip()
    return [c.strip() for c in raw.split(",") if c.strip()] if raw else []


def _specs_from_env() -> List[Dict[str, Any]]:
    """Gateway specs from env — one block per platform, each gated on its token."""
    specs: List[Dict[str, Any]] = []

    # Telegram (HTTP long-poll)
    tg = (os.environ.get("GATEWAY_TELEGRAM_BOT_TOKEN") or "").strip()
    if tg:
        cfg: Dict[str, Any] = {"token": tg}
        allowed = _csv("GATEWAY_TELEGRAM_ALLOWED_CHAT_IDS")
        if allowed:
            cfg["allowed_chat_ids"] = allowed
        specs.append({"platform": "telegram", "config": cfg})

    # Discord (Gateway WebSocket)
    dc = (os.environ.get("GATEWAY_DISCORD_BOT_TOKEN") or "").strip()
    if dc:
        cfg = {"token": dc}
        allowed = _csv("GATEWAY_DISCORD_ALLOWED_CHANNEL_IDS")
        if allowed:
            cfg["allowed_channel_ids"] = allowed
        specs.append({"platform": "discord", "config": cfg})

    # Slack (Socket Mode — needs both an app token and a bot token)
    slack_app = (os.environ.get("GATEWAY_SLACK_APP_TOKEN") or "").strip()
    slack_bot = (os.environ.get("GATEWAY_SLACK_BOT_TOKEN") or "").strip()
    if slack_app and slack_bot:
        cfg = {"app_token": slack_app, "bot_token": slack_bot}
        allowed = _csv("GATEWAY_SLACK_ALLOWED_CHANNEL_IDS")
        if allowed:
            cfg["allowed_channel_ids"] = allowed
        specs.append({"platform": "slack", "config": cfg})

    return specs


def _specs_from_geny_config() -> List[Dict[str, Any]]:
    """Gateway specs from the Geny config UI (Settings → Channels).

    Each channel config (telegram / discord / slack) is the user-facing editor;
    when ``enabled`` + the required token(s) are set, it produces a gateway spec.
    This is the primary, UI-driven source.
    """
    try:
        from service.config import get_config_manager
        from service.config.sub_config.channels.discord_config import DiscordConfig
        from service.config.sub_config.channels.slack_config import SlackConfig
        from service.config.sub_config.channels.telegram_config import TelegramConfig
    except Exception:  # noqa: BLE001 — config layer unavailable very early
        return []

    cm = get_config_manager()
    specs: List[Dict[str, Any]] = []

    tg = cm.load_config(TelegramConfig)
    if getattr(tg, "enabled", False) and (tg.bot_token or "").strip():
        cfg: Dict[str, Any] = {"token": tg.bot_token.strip()}
        if tg.allowed_chat_ids:
            cfg["allowed_chat_ids"] = list(tg.allowed_chat_ids)
        specs.append({"platform": "telegram", "config": cfg})

    dc = cm.load_config(DiscordConfig)
    if getattr(dc, "enabled", False) and (dc.bot_token or "").strip():
        cfg = {"token": dc.bot_token.strip()}
        if dc.allowed_channel_ids:
            cfg["allowed_channel_ids"] = list(dc.allowed_channel_ids)
        specs.append({"platform": "discord", "config": cfg})

    sl = cm.load_config(SlackConfig)
    if (
        getattr(sl, "enabled", False)
        and (sl.app_token or "").strip()
        and (sl.bot_token or "").strip()
    ):
        cfg = {"app_token": sl.app_token.strip(), "bot_token": sl.bot_token.strip()}
        if sl.allowed_channel_ids:
            cfg["allowed_channel_ids"] = list(sl.allowed_channel_ids)
        specs.append({"platform": "slack", "config": cfg})

    return specs


def _specs_from_settings() -> List[Dict[str, Any]]:
    try:
        from geny_executor.settings import get_default_loader
    except ImportError:
        return []
    try:
        section = get_default_loader().get_section("gateway")
    except Exception:  # noqa: BLE001 — settings unavailable early in boot
        return []
    if section is None:
        return []
    data = section.model_dump(exclude_none=True) if hasattr(section, "model_dump") else dict(section)
    platforms = data.get("platforms") or []
    return [p for p in platforms if isinstance(p, dict) and p.get("platform")]


def load_gateway_specs() -> List[Dict[str, Any]]:
    """Gateway specs from all sources, de-duplicated by platform.

    Priority (first wins per platform): Geny config UI (Settings → Channels) →
    settings.json ``gateway.platforms`` → env vars. So a channel configured in
    the UI takes over from an env fallback.
    """
    seen: set[str] = set()
    merged: List[Dict[str, Any]] = []
    for source in (_specs_from_geny_config(), _specs_from_settings(), _specs_from_env()):
        for spec in source:
            platform = spec.get("platform")
            if not platform or platform in seen:
                continue
            seen.add(platform)
            merged.append(spec)
    return merged


async def install_gateway() -> Optional[Any]:
    """Build + start the gateway runner if any platform is configured.

    Returns the started ``GatewayRunner`` (store it on ``app.state`` so the
    shutdown hook can stop it), or ``None`` when nothing is configured / the
    executor is too old.
    """
    specs = load_gateway_specs()
    if not specs:
        return None
    try:
        from geny_executor.gateway import build_gateway

        from service.gateway.handler import handle_inbound
    except ImportError as exc:
        logger.warning("gateway: unavailable (%s) — need geny-executor>=2.11.0", exc)
        return None

    runner = build_gateway(specs, handle_inbound)
    if not runner.adapters:
        logger.warning("gateway: no valid platforms built from %d spec(s)", len(specs))
        return None
    await runner.start()
    logger.info("gateway started platforms=%s", [a.name for a in runner.adapters])
    return runner


async def reload_gateway(app_state: Any) -> Optional[Any]:
    """Stop the running gateway and start a fresh one from current config.

    Called after a Channels config is saved so enabling/disabling a platform in
    the UI takes effect without a backend restart. Stores the new runner on
    ``app_state.gateway_runner`` (or ``None`` when nothing is configured).
    """
    old = getattr(app_state, "gateway_runner", None)
    if old is not None:
        try:
            await old.shutdown(timeout=5)
        except Exception:  # noqa: BLE001 — best-effort
            logger.warning("gateway reload: old runner shutdown failed", exc_info=True)
    runner = await install_gateway()
    try:
        app_state.gateway_runner = runner
    except Exception:  # noqa: BLE001
        pass
    logger.info(
        "gateway reloaded platforms=%s",
        [a.name for a in runner.adapters] if runner else [],
    )
    return runner


__all__ = ["install_gateway", "reload_gateway", "load_gateway_specs"]
