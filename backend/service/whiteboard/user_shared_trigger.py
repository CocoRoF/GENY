"""
[USER_SHARED] trigger — fires after a Spotlight item is staged so the
VTuber agent gets one immediate prompt to acknowledge the share.

Mirrors the pattern used by ``service.vtuber.thinking_trigger``:
  1. Compose a synthetic prompt that begins with ``[USER_SHARED]``.
  2. Hand it to ``service.execution.agent_executor.execute_command``
     with ``is_trigger=True`` so the agent's pipeline runs once.
  3. Catch every exception so a trigger failure never affects the
     user-visible Spotlight share.

Without this, a Spotlight item only surfaces on the *next* user turn
(via :class:`SpotlightContextBlock`). With it, the VTuber acknowledges
the share immediately.
"""

from __future__ import annotations

import asyncio
import json
from logging import getLogger
from typing import Any, Dict, Optional

from .agent_resolver import resolve_user_and_agent
from .types import SpotlightItem
from .view_ledger import get_view_ledger

logger = getLogger(__name__)


def _compose_trigger_prompt(
    item: SpotlightItem, *, seen_before: bool
) -> str:
    """Compose the [USER_SHARED] prompt body."""
    excerpt = (item.excerpt or "").strip()
    if len(excerpt) > 320:
        excerpt = excerpt[:317] + "…"
    payload: Dict[str, Any] = {
        "title": item.title,
        "kind": item.note_kind,
        "source_filename": item.source_filename,
        "excerpt": excerpt,
        "seen_before": bool(seen_before),
        "attachments_count": len(item.attachments or ()),
    }
    body = (
        "사용자가 방금 위 자료를 공유했습니다. "
        "자연스럽게 화제로 꺼내거나 짧게 의견을 표현하세요. "
        "이미 본 자료(seen_before=true)라면 처음 마주친 듯 다루지 말고 "
        "이전 맥락에 이어서 말하세요."
    )
    return (
        f"[USER_SHARED] {json.dumps(payload, ensure_ascii=False)}\n"
        f"{body}"
    )


def fire_user_shared_trigger_async(
    item: SpotlightItem,
) -> Optional[asyncio.Task]:
    """Schedule the [USER_SHARED] trigger as a background task.

    Returns the created task (mainly for tests). Returns ``None`` when
    the call is made outside an asyncio loop or the resolver cannot
    derive a session — both are silent no-ops because the trigger is
    a "nice to have" on top of the per-turn SpotlightContextBlock.
    """
    if not item.session_id:
        # Spotlight is only useful when bound to a live session. The
        # SpotlightContextBlock still works for user-wide items at
        # whatever session the user opens next.
        return None
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        # Called from a sync context with no loop — let the caller
        # decide whether to spin one up. We don't want to start a
        # fresh loop here and risk leaking it.
        logger.debug(
            "fire_user_shared_trigger: no running loop, skipping",
            exc_info=False,
        )
        return None
    return loop.create_task(_run_trigger_safely(item))


async def _run_trigger_safely(item: SpotlightItem) -> None:
    """Wrapper that swallows any error. Trigger failure must never
    surface to the user-facing share request."""
    try:
        await _run_trigger(item)
    except Exception:  # noqa: BLE001
        logger.warning(
            "USER_SHARED trigger failed for session %s item %s",
            item.session_id,
            item.item_id,
            exc_info=True,
        )


async def _run_trigger(item: SpotlightItem) -> None:
    session_id = item.session_id
    if not session_id:
        return

    # Snapshot view-meta now so the trigger payload reflects the state
    # *before* the imminent SpotlightContextBlock 'injected' tick.
    seen_before = False
    try:
        username, agent_id = resolve_user_and_agent(session_id)
        if username and agent_id:
            ledger = get_view_ledger(username, agent_id)
            record = ledger.get(item.source_filename)
            seen_before = bool(record and record.has_seen())
    except Exception:  # noqa: BLE001
        pass

    prompt = _compose_trigger_prompt(item, seen_before=seen_before)

    try:
        from service.execution.agent_executor import execute_command  # type: ignore
    except Exception:  # noqa: BLE001
        logger.debug(
            "USER_SHARED: agent_executor unavailable, trigger skipped",
            exc_info=True,
        )
        return

    try:
        await execute_command(
            session_id,
            prompt,
            is_trigger=True,
            timeout=180.0,
        )
        logger.info(
            "USER_SHARED trigger fired for session %s item %s (seen_before=%s)",
            session_id,
            item.item_id,
            seen_before,
        )
    except Exception:  # noqa: BLE001
        logger.warning(
            "USER_SHARED trigger execute_command failed",
            exc_info=True,
        )
