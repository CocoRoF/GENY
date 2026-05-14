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


# Spotlight items that should be framed as *ambient overhearing* instead
# of a deliberate share. Currently only V2's auto-VAD stream sets this —
# every utterance the user happens to make while STT mode is on lands
# here. The persona should treat these like passively-overheard speech,
# not a memo the user "delivered" to them.
_AMBIENT_SOURCES: frozenset[str] = frozenset({"vtuber_stt_stream"})


def _is_ambient_share(item: SpotlightItem) -> bool:
    """True when the item came from an auto-VAD path (no deliberate
    Share-with-VTuber click)."""
    meta = item.metadata or {}
    src = str(meta.get("source") or "").strip().lower()
    return src in _AMBIENT_SOURCES


def _compose_trigger_prompt(
    item: SpotlightItem, *, seen_before: bool
) -> str:
    """Compose the [USER_SHARED] prompt body.

    The framing branches on the spotlight item's source metadata so
    the persona perceives ambient overhearing (V2 STT stream) and
    deliberate shares as different events. Without the branch every
    capture reads as "사용자가 방금 위 자료를 공유했습니다" and the
    VTuber over-eagerly reacts to every cough / mouse click /
    half-finished filler.
    """
    excerpt = (item.excerpt or "").strip()
    if len(excerpt) > 320:
        excerpt = excerpt[:317] + "…"
    ambient = _is_ambient_share(item)
    payload: Dict[str, Any] = {
        "title": item.title,
        "kind": item.note_kind,
        "source_filename": item.source_filename,
        "excerpt": excerpt,
        "seen_before": bool(seen_before),
        "attachments_count": len(item.attachments or ()),
        # Surface the metadata so a skill (e.g. ``whiteboard-voice-notes``)
        # can branch on it explicitly. ``ambient`` mirrors the prompt-
        # body branch; ``share_source`` carries the raw enum string.
        "ambient": ambient,
        "share_source": str(
            (item.metadata or {}).get("source") or ""
        ).strip().lower(),
    }
    if ambient:
        # Ambient framing — overheard, not delivered. The persona should
        # often stay quiet; respond only when the content is clearly
        # addressed to them (their name, a direct question, etc.) or
        # when there's a thread worth picking up.
        body = (
            "위 내용은 사용자가 직접 너에게 보낸 메시지가 아니라, "
            "STT 가 마이크에서 우연히 잡은 발화야 — *너는 옆에서 한 마디 듣게 된 것*뿐이다. "
            "다음 규칙을 지켜:\n"
            "  • 본인에게 한 명확한 말 (호명, 직접 질문) 이 아니면 *침묵해도 좋다*. "
            "응답이 필요해 보이면 1~2문장 짧은 호응만 한다.\n"
            "  • 절대 \"~를 공유해 주셨네요\" 류 표현 금지. "
            "\"방금 [내용] 라고 하셨나봐\" / \"옆에서 들었는데 [내용]\" 같이 "
            "엿들은 톤으로 풀어라.\n"
            "  • 동일 burst 의 여러 spotlight 항목은 *전체를 보고 한 번에* 반응. "
            "각 발화마다 답하지 말 것.\n"
            "  • 한 사람이 혼잣말 / 다른 사람과 대화 / 비속어 일 수 있다는 가능성을 항상 염두에 두고, "
            "확신 없는 추측은 하지 말고 자연스럽게 흘려보낸다."
        )
    else:
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
    the call is made outside an asyncio loop or the spotlight has no
    session id — both are silent no-ops because the trigger is a
    "nice to have" on top of the per-turn SpotlightContextBlock.

    The Task handle is held by ``_task_tracker`` until it completes
    so the event-loop GC can't reap it before the trigger finishes.
    """
    if not item.session_id:
        # Spotlight is only useful when bound to a live session. The
        # SpotlightContextBlock still works for user-wide items at
        # whatever session the user opens next.
        return None
    from ._task_tracker import schedule

    return schedule(
        _run_trigger_safely(item),
        name=f"whiteboard.user_shared[{item.session_id[:8]}:{item.item_id[:8]}]",
    )


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
        result = await execute_command(
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
        # Mirror ThinkingTriggerService — without this the response
        # is generated but never appears in the chat room (it goes
        # nowhere because trigger-mode bypasses the normal user-input
        # broadcast path).
        if result is not None:
            _save_trigger_response_to_chat(session_id, item, result)
    except Exception:  # noqa: BLE001
        logger.warning(
            "USER_SHARED trigger execute_command failed",
            exc_info=True,
        )


def _save_trigger_response_to_chat(
    session_id: str, item: SpotlightItem, result: Any
) -> None:
    """Push the [USER_SHARED] response into the agent's chat room.

    Mirrors ``ThinkingTriggerService._save_to_chat_room`` so the
    user actually sees the VTuber's reaction in their chat panel.
    Best-effort: any failure here just logs a warning and the
    user keeps the in-prompt acknowledgement on the next turn via
    ``SpotlightContextBlock``.
    """
    try:
        if not getattr(result, "success", False):
            return
        output = getattr(result, "output", "") or ""

        # Sanitise consistent with ThinkingTrigger's path so leaked
        # ``[curious]`` / ``[calm]`` tags / TTS sentinels don't reach
        # the panel.
        try:
            from service.utils.text_sanitizer import sanitize_for_display
            cleaned = sanitize_for_display(output)
        except Exception:  # noqa: BLE001
            cleaned = output
        if not cleaned or not cleaned.strip():
            return

        try:
            from service.executor import get_agent_session_manager
        except Exception:  # noqa: BLE001
            logger.debug("agent_session_manager unavailable", exc_info=True)
            return
        agent = get_agent_session_manager().get_agent(session_id)
        if agent is None:
            logger.debug(
                "USER_SHARED save: no agent for %s, skipping",
                session_id,
            )
            return

        chat_room_id = getattr(agent, "_chat_room_id", None)
        if not chat_room_id:
            logger.debug(
                "USER_SHARED save: no chat_room_id on agent %s, skipping",
                session_id,
            )
            return

        try:
            from service.chat.conversation_store import get_chat_store
            store = get_chat_store()
        except Exception:  # noqa: BLE001
            logger.debug("chat store unavailable", exc_info=True)
            return

        session_name = (
            getattr(agent, "_session_name", None) or session_id
        )
        role_val = getattr(agent, "_role", None)
        role = (
            role_val.value
            if hasattr(role_val, "value")
            else str(role_val or "vtuber")
        )

        msg = store.add_message(
            chat_room_id,
            {
                "type": "agent",
                "content": cleaned,
                "session_id": session_id,
                "session_name": session_name,
                "role": role,
                "duration_ms": getattr(result, "duration_ms", None),
                "cost_usd": getattr(result, "cost_usd", None),
                "source": "user_shared_trigger",
                "metadata": {
                    "spotlight_item_id": item.item_id,
                    "source_filename": item.source_filename,
                },
            },
        )
        logger.info(
            "USER_SHARED response saved to chat room %s (msg_id=%s, len=%d)",
            chat_room_id,
            msg.get("id", "?"),
            len(cleaned),
        )
        try:
            from controller.chat_controller import _notify_room
            _notify_room(chat_room_id)
        except Exception:  # noqa: BLE001
            logger.debug(
                "USER_SHARED notify_room failed for %s",
                chat_room_id,
                exc_info=True,
            )
    except Exception:  # noqa: BLE001
        logger.warning(
            "USER_SHARED save_to_chat_room failed", exc_info=True
        )
