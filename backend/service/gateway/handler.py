"""Gateway handler — inbound chat message → one Geny VTuber turn → reply text.

This is the seam geny-executor's ``GatewayRunner`` calls: ``(InboundMessage) ->
reply str | None``. It get-or-creates a session keyed by ``{platform}-{chat_id}``
(so each chat is a persistent companion) and runs one headless turn via
``execute_command`` — the same WS-free path the in-app messenger uses.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Dict, Optional

from geny_executor.gateway import InboundMessage

logger = logging.getLogger(__name__)

# Per-conversation create lock so two near-simultaneous first messages from the
# same chat don't both try to create the (unique-named) session.
_create_locks: Dict[str, asyncio.Lock] = {}


def _lock_for(name: str) -> asyncio.Lock:
    lock = _create_locks.get(name)
    if lock is None:
        lock = _create_locks[name] = asyncio.Lock()
    return lock


async def _get_or_create_session(platform: str, chat_id: str) -> str:
    """Deterministic ``{platform}-{chat_id}`` session, created once (VTuber env)."""
    from service.executor import get_agent_session_manager
    from service.sessions.models import CreateSessionRequest, SessionRole

    mgr = get_agent_session_manager()
    name = f"{platform}-{chat_id}"
    async with _lock_for(name):
        agent = mgr.get_agent_by_name(name)
        if agent is None:
            agent = await mgr.create_agent_session(
                CreateSessionRequest(session_name=name, role=SessionRole.VTUBER),
                owner_username="gateway",
            )
        return agent.session_id


async def handle_inbound(message: InboundMessage) -> Optional[str]:
    """Run one turn for the inbound message; return reply text or ``None``."""
    from service.execution.agent_executor import (
        AgentNotAliveError,
        AgentNotFoundError,
        AlreadyExecutingError,
        execute_command,
    )

    try:
        session_id = await _get_or_create_session(message.platform, message.chat_id)
    except Exception as exc:  # noqa: BLE001 — e.g. no LLM provider configured
        logger.warning(
            "gateway_session_create_failed platform=%s chat=%s err=%s",
            message.platform,
            message.chat_id,
            exc,
        )
        return None

    try:
        result = await execute_command(session_id, message.text, is_chat_message=True)
    except AlreadyExecutingError:
        # A turn for this chat is still running — drop the new message rather
        # than interleave; the in-flight turn will reply. (Per-chat queueing is
        # a future refinement.)
        return None
    except (AgentNotFoundError, AgentNotAliveError) as exc:
        logger.warning("gateway_session_unavailable chat=%s err=%s", message.chat_id, exc)
        return None
    except Exception as exc:  # noqa: BLE001
        logger.warning("gateway_execute_failed chat=%s err=%s", message.chat_id, exc)
        return None

    if result.success and result.output and result.output.strip():
        try:
            from service.utils.text_sanitizer import sanitize_for_display

            return sanitize_for_display(result.output)
        except Exception:  # noqa: BLE001 — sanitizer optional
            return result.output
    return None


__all__ = ["handle_inbound"]
