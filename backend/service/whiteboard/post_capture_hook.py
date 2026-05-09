"""
PostCaptureHook — dispatcher mapping ``CaptureType`` → an analysis
callable that runs immediately after a capture is staged.

Purpose: a freshly captured screenshot from a *non-vision* model
needs a text description so the agent has something concrete to talk
about. The hook system runs that description (or an OCR pass, or a
transcript) on a background task right after the user shares the
capture, then patches the resulting note's body / spotlight excerpt.

Design rules:
  * Hooks are best-effort: any failure logs at warning and never
    affects the user-facing capture flow.
  * Each hook is keyed by the ``CaptureType`` it handles. New types
    can register a hook by calling :func:`register_post_capture_hook`
    once at module load (mirrors how ``captureSources`` works on
    the frontend — single seam).
  * Hooks see the freshly-staged ``CaptureEvent`` plus the
    ``draft_note`` filename so they can update either the note body
    or the spotlight item's excerpt as appropriate.

P4 scope ships:
  * One built-in hook for ``screenshot`` / ``image`` that calls
    :func:`describe_attachment_async` (the LLM helper landed alongside
    this dispatcher) when the active model is *not* vision-capable.
  * The dispatcher is invoked from :func:`whiteboard_controller._persist_capture`
    after a successful write, on a fire-and-forget asyncio task.
"""

from __future__ import annotations

import asyncio
from logging import getLogger
from typing import Any, Awaitable, Callable, Dict, Optional

from .types import CaptureEvent, CaptureType

logger = getLogger(__name__)


PostCaptureHook = Callable[
    [CaptureEvent, str],
    Awaitable[Optional[Dict[str, Any]]],
]
"""(event, draft_note_filename) → optional patch result.

The patch result is mostly informational (returned to logs / future
audit logging); the hook itself is responsible for any side-effects
on the underlying note or spotlight item.
"""


_HOOKS: Dict[str, PostCaptureHook] = {}


def register_post_capture_hook(
    capture_type: CaptureType, hook: PostCaptureHook
) -> Callable[[], None]:
    """Register a hook for ``capture_type``.

    Returns an unregister callback (handy for tests / per-session
    plugin lifecycles). Re-registering the same type replaces the
    previous hook — easier than building a list when the typical
    case is "one analysis per type".
    """
    _HOOKS[capture_type] = hook

    def _unregister() -> None:
        if _HOOKS.get(capture_type) is hook:
            _HOOKS.pop(capture_type, None)

    return _unregister


def get_post_capture_hook(
    capture_type: CaptureType,
) -> Optional[PostCaptureHook]:
    return _HOOKS.get(capture_type)


def clear_hooks_for_tests() -> None:
    _HOOKS.clear()


async def dispatch_post_capture(
    event: CaptureEvent, draft_note_filename: str
) -> Optional[Dict[str, Any]]:
    """Run the hook registered for ``event.type`` (if any).

    Best-effort wrapper: catches every exception, returns ``None`` on
    failure. The wrapper is the single point of contact for the
    capture controller — controllers should never call hooks directly.
    """
    hook = get_post_capture_hook(event.type)
    if hook is None:
        return None
    try:
        return await hook(event, draft_note_filename)
    except Exception:  # noqa: BLE001
        logger.warning(
            "PostCaptureHook failed for type=%s capture_id=%s",
            event.type,
            event.capture_id,
            exc_info=True,
        )
        return None


def fire_and_forget(
    event: CaptureEvent, draft_note_filename: str
) -> Optional[asyncio.Task]:
    """Schedule a post-capture hook on the running asyncio loop.

    Returns the created task (mainly for tests). Returns ``None``
    when called from a sync context with no running loop — the
    capture path stays best-effort and never blocks on a hook.

    The Task handle is held by the shared ``_task_tracker`` until it
    completes so the GC can't reap a hook mid-flight (CPython only
    keeps weak refs to event-loop tasks).
    """
    from ._task_tracker import schedule

    return schedule(
        dispatch_post_capture(event, draft_note_filename),
        name=f"whiteboard.post_capture[{event.type}:{event.capture_id[:8]}]",
    )


# ── Built-in hooks ───────────────────────────────────────────────────


async def _describe_image_hook(
    event: CaptureEvent, draft_note_filename: str
) -> Optional[Dict[str, Any]]:
    """Default hook for ``image`` / ``screenshot`` captures.

    Calls the vision LLM (when configured) to caption the attachment,
    then prepends the caption as a quoted block at the top of the
    draft note's body. Non-vision configs fall back to a placeholder
    that hints to the agent without lying.
    """
    if not event.payload.attachment_path:
        return None
    try:
        from tools.custom.whiteboard_tools import describe_attachment_async
    except Exception:  # noqa: BLE001
        logger.debug("describe_attachment_async unavailable", exc_info=True)
        return None
    try:
        result = await describe_attachment_async(
            event.user_id,
            attachment_path=event.payload.attachment_path,
        )
    except Exception:  # noqa: BLE001
        logger.warning("describe hook failed", exc_info=True)
        return None
    description = (result or {}).get("description", "").strip()
    source = (result or {}).get("source")
    if not description or source != "vision":
        # Don't pollute the user's note body with the placeholder
        # text — only persist *real* vision-LLM captions. The hook
        # still returns the result for audit logging.
        return result

    try:
        from service.memory.user_opsidian import get_user_opsidian_manager
    except Exception:  # noqa: BLE001
        return result
    mgr = get_user_opsidian_manager(event.user_id)
    note = mgr.read_note(draft_note_filename)
    if not note:
        return result
    body = str(note.get("body") or "")
    block = f"> **Auto-caption:** {description}\n\n"
    if block.strip() in body:
        return result  # already added — idempotent re-runs.
    new_body = block + body
    try:
        mgr.update_note(draft_note_filename, body=new_body)
    except Exception:  # noqa: BLE001
        logger.debug("describe hook: note update failed", exc_info=True)
    return result


def register_default_hooks() -> None:
    """Register the built-in P4 hooks. Idempotent."""
    register_post_capture_hook("image", _describe_image_hook)
    register_post_capture_hook("screenshot", _describe_image_hook)


# Auto-register on first import — keeps the call-site clean.
register_default_hooks()
