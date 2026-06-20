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
    """Gateway platform specs from settings + env (env appended)."""
    specs = _specs_from_settings()
    specs.extend(_specs_from_env())
    return specs


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


__all__ = ["install_gateway", "load_gateway_specs"]
