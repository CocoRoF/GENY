"""Pin policy — Geny's host-side rule for promoting insights to ``memory/critical/``.

This module is the concrete *policy* counterpart to the executor's
generic ``GenyMemoryStrategy.promote_callback`` hook (geny-executor
≥ 1.13.0). The executor decides *when* to call the callback (after
an insight has cleared the importance gate); Geny decides *what*
that means — namely, write a copy of the insight into the
``critical/`` category so the next turn's
``GenyMemoryRetriever._load_pinned_facts`` can lift it into the
system prompt's ``# Pinned Facts`` section.

Keeping the policy in a separate module is deliberate:

  1. The executor stays generic (no knowledge of "critical").
  2. The host (Geny) owns the on-disk shape and can evolve it
     (e.g. add per-user ``critical/<username>/``) without touching
     ``geny_executor``.
  3. Tests can call ``promote_to_critical`` directly to exercise
     the file-write path without spinning up a full pipeline.

Cycle 20260503_1 — Memory v2 PR 12 host side.
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Dict, List, Optional

from service.memory.note_utils import PINNED_CATEGORY

logger = logging.getLogger(__name__)


def promote_to_critical(insight: Dict[str, Any], memory_manager: Any) -> None:
    """Write ``insight`` into the host's ``critical/`` category.

    Signature matches the executor's
    ``GenyMemoryStrategy.promote_callback`` contract:
    ``(insight: Dict[str, Any], memory_manager: Any) -> None``.

    The function is intentionally permissive — missing fields fall
    back to safe defaults so a malformed insight cannot wedge the
    promotion path. Failures log at debug level; the executor
    already wraps the call in its own try/except so any exception
    here is a soft failure (the insight still lives under
    ``insights/``; only the pinned copy is missing).
    """
    if not isinstance(insight, dict):
        logger.debug(
            "pin_policy.promote_to_critical: ignored non-dict insight (%r)",
            type(insight).__name__,
        )
        return

    write_note = getattr(memory_manager, "write_note", None)
    if write_note is None:
        logger.debug(
            "pin_policy.promote_to_critical: memory_manager has no write_note; skipping"
        )
        return

    title = str(insight.get("title") or "Pinned Insight").strip() or "Pinned Insight"
    content = str(insight.get("content") or "").strip()
    if not content:
        logger.debug("pin_policy.promote_to_critical: empty content for %r", title)
        return

    raw_tags = insight.get("tags") or []
    if isinstance(raw_tags, (list, tuple)):
        tags = [str(t) for t in raw_tags if isinstance(t, (str, int, float))]
    else:
        tags = []
    # ``pinned`` and ``auto-pinned`` mark how the note arrived in
    # ``critical/`` — useful for audit + later UI filters.
    for marker in ("pinned", "auto-pinned"):
        if marker not in tags:
            tags.append(marker)

    importance = str(insight.get("importance") or "high").lower()
    # Carry the original category as a tag so curators can see what
    # bucket the insight came from.
    original_category = insight.get("category")
    if isinstance(original_category, str) and original_category.strip():
        origin_tag = f"from:{original_category.strip()}"
        if origin_tag not in tags:
            tags.append(origin_tag)

    try:
        write_note(
            title=title,
            content=content,
            category=PINNED_CATEGORY,
            tags=tags,
            importance=importance,
            source="auto_pinned",
        )
    except Exception:
        logger.debug(
            "pin_policy.promote_to_critical: write_note failed for %r",
            title,
            exc_info=True,
        )


def make_promote_callback(
    *,
    extra_callbacks: Optional[List[Callable[[Dict[str, Any], Any], None]]] = None,
) -> Callable[[Dict[str, Any], Any], None]:
    """Build the callback Geny registers on ``GenyMemoryStrategy``.

    Returns a function with the executor's promote-callback signature
    that calls :func:`promote_to_critical` and, optionally, any
    additional host callbacks (e.g. analytics emit, broadcast event).
    Each extra callback is run inside its own try/except so one
    failure cannot suppress the others.
    """
    callbacks: List[Callable[[Dict[str, Any], Any], None]] = [promote_to_critical]
    if extra_callbacks:
        callbacks.extend(extra_callbacks)

    def _runner(insight: Dict[str, Any], memory_manager: Any) -> None:
        for cb in callbacks:
            try:
                cb(insight, memory_manager)
            except Exception:  # pragma: no cover — best-effort chain
                logger.debug(
                    "pin_policy: chained callback %r failed",
                    getattr(cb, "__name__", repr(cb)),
                    exc_info=True,
                )

    return _runner


__all__ = ["promote_to_critical", "make_promote_callback"]
