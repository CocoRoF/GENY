"""Wire notification endpoints + send-message channels.

Sources (priority highest-first):

    1. ~/.geny/notifications.json   (json: {"endpoints": [...]})
    2. .geny/notifications.json
    3. NOTIFICATION_ENDPOINTS env (json string)

P1.3 cycle migrates these onto the unified settings.json. For now
yaml/env keeps the wire simple.

Channel registry ships with the StdoutSendMessageChannel as the
"geny" reference; hosts wire Discord / Slack / etc by registering
their own SendMessageChannel impls.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


def _load_endpoints_from_path(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        logger.warning("notifications_invalid_json path=%s err=%s", path, exc)
        return []
    return list(data.get("endpoints") or [])


def install_notification_endpoints() -> Optional[Any]:
    """Returns the registry, or None if executor 1.1.0 isn't available."""
    try:
        from geny_executor.notifications import (
            NotificationEndpoint,
            NotificationEndpointRegistry,
        )
    except ImportError:
        return None

    registry = NotificationEndpointRegistry()
    sources: List[Dict[str, Any]] = []
    sources += _load_endpoints_from_path(Path.home() / ".geny" / "notifications.json")
    sources += _load_endpoints_from_path(Path(".geny") / "notifications.json")
    env_blob = os.getenv("NOTIFICATION_ENDPOINTS")
    if env_blob:
        try:
            env_endpoints = json.loads(env_blob)
            if isinstance(env_endpoints, list):
                sources += env_endpoints
        except json.JSONDecodeError as exc:
            logger.warning("NOTIFICATION_ENDPOINTS env parse failed: %s", exc)
    for entry in sources:
        try:
            registry.register(NotificationEndpoint(**entry))
        except Exception as exc:  # noqa: BLE001
            logger.warning("notification_endpoint_skipped entry=%s err=%s", entry, exc)
    logger.info("notification_endpoints registered=%d", len(registry.list()))
    return registry


def install_send_message_channels() -> Optional[Any]:
    """Wire SendMessage channels. Default ships only StdoutSendMessageChannel
    under the 'geny' name — hosts register Discord/Slack/etc here."""
    try:
        from geny_executor.channels import (
            SendMessageChannelRegistry,
            StdoutSendMessageChannel,
        )
    except ImportError:
        return None

    registry = SendMessageChannelRegistry()
    registry.register("geny", StdoutSendMessageChannel())
    # Hosts that want richer channels add them by mutating
    # app.state.send_message_channels post-install. Future PR can
    # auto-discover from settings.json (P1.3 cycle).
    logger.info("send_message_channels registered=%d", len(registry.list()))
    return registry


__all__ = ["install_notification_endpoints", "install_send_message_channels"]
