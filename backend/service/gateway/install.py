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


def _specs_from_env() -> List[Dict[str, Any]]:
    token = (os.environ.get("GATEWAY_TELEGRAM_BOT_TOKEN") or "").strip()
    if not token:
        return []
    config: Dict[str, Any] = {"token": token}
    allowed = (os.environ.get("GATEWAY_TELEGRAM_ALLOWED_CHAT_IDS") or "").strip()
    if allowed:
        config["allowed_chat_ids"] = [c.strip() for c in allowed.split(",") if c.strip()]
    return [{"platform": "telegram", "config": config}]


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
