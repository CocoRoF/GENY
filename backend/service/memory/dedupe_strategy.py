"""GenyDedupeStrategy — cycle 20260501_1 C.

Single STM write site at s18_memory.

Background — before this cycle the codebase had *two* writers
recording every user / assistant turn into the session's STM:

  1. ``AgentSession._invoke_pipeline`` / ``_astream_pipeline`` —
     called ``record_message(role, content, metadata=…)`` directly
     at invoke start (user) and again at invoke end (assistant).
     This carried the full InteractionEvent metadata (cycle
     20260430_2).
  2. ``s18_memory.GenyMemoryStrategy._record_transcript`` —
     called ``record_message(role, content)`` for every
     ``state.messages`` entry on terminal state. Without metadata.

Result: every user / assistant turn was recorded *twice* into STM.
``recent_turns`` retrieval and the new transcripts API both
showed duplicates; the second copy lacked metadata so InteractionEvent
filters silently dropped half of it.

Cycle 20260501_1 C consolidates: ``_invoke_pipeline`` no longer
calls ``record_message`` itself; instead it stamps the resolved
metadata for the upcoming user / assistant turn onto
``state.metadata['_pending_message_metadata']``. This subclass'
``_record_transcript`` reads that hint when it walks
``state.messages`` so the *canonical* record happens exactly once,
inside s18, with full metadata.

Invariants this class enforces:

  * STM record_message has a single call site (s18) for every
    user / assistant message. (The cycle-20260430_3 entity_bootstrap
    side-effect was retired in Memory v2 — counterpart context now
    rides solely on the dms/ index path.)
  * InteractionEvent metadata threaded through unchanged from the
    Geny-side resolver to the LTM line.
  * Empty / non-text content blocks are dropped silently (parent
    class behaviour preserved).
"""

from __future__ import annotations

import logging
from typing import Any, Dict

from geny_executor.core.state import PipelineState
from geny_executor.memory.strategy import GenyMemoryStrategy

logger = logging.getLogger(__name__)


_PENDING_KEY = "_pending_message_metadata"


class GenyDedupeStrategy(GenyMemoryStrategy):
    """``GenyMemoryStrategy`` subclass that respects metadata hints
    pushed by ``AgentSession._invoke_pipeline`` (cycle 20260501_1 C).

    The hint is a dict shaped ``{"user": <metadata>, "assistant":
    <metadata>}`` placed on ``state.metadata`` before the pipeline
    runs. Each metadata value is the output of
    ``make_event_metadata`` (cycle 20260430_2). When we walk the
    new ``state.messages`` slice we:

      * apply the ``user`` hint to the *first* user message we
        record this batch;
      * apply the ``assistant`` hint to the *first* assistant
        message;
      * for any *subsequent* same-role message in the same batch,
        derive a *fresh* metadata dict from the same template —
        new ``event_id``, identical kind / direction /
        counterpart_id / counterpart_role / linked_event_id /
        payload (cycle 20260501_2 F1). A single VTuber turn that
        produces multiple assistant messages must not have half
        of them recorded with ``metadata=None``.
      * fall back to ``metadata=None`` only when no hint exists
        for the role at all.

    The hint is *not* popped — kept on state for the duration of
    the turn so a hypothetical second walk (re-entrant strategy
    chain) sees the same value. ``_stm_recorded_count`` advances
    as in the parent so a second invocation in the same turn is a
    no-op.
    """

    def _record_transcript(self, state: PipelineState) -> None:
        """Stamp pending InteractionEvent metadata onto each new
        message dict so stage 18's `_drive_provider` carries it into
        STM (executor 1.17.0 EXEC-1: `Turn.from_state_message` lifts
        `message["metadata"]` onto `Turn.metadata`).

        Path-A migration GENY-2: this strategy no longer calls
        `mgr.record_message`. The executor's `_drive_provider` is
        the single STM write site; this method's only remaining job
        is to attach the `_pending_message_metadata` hint to the
        right message before the provider walks `state.messages`.

        Idempotency: walks only the slice past
        `_stm_recorded_count`. If `_drive_provider` already updated
        the cursor (it uses its own `memory.last_recorded_idx`),
        we still respect ours so re-entry doesn't double-stamp.
        """
        pending = state.metadata.get(_PENDING_KEY) or {}
        recorded_count = int(state.metadata.get("_stm_recorded_count", 0))
        new_messages = state.messages[recorded_count:]

        applied = {"user": False, "assistant": False}

        for msg in new_messages:
            role = msg.get("role", "")
            if role not in ("user", "assistant"):
                continue

            content = msg.get("content", "")
            if isinstance(content, list):
                text_parts = []
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        text_parts.append(block.get("text", ""))
                content = "\n".join(text_parts)
            if not content:
                continue

            hint = pending.get(role)
            metadata: Dict[str, Any] | None = None
            if isinstance(hint, dict) and hint:
                metadata = hint if not applied[role] else _fresh_from_template(hint)
            applied[role] = True

            if metadata and isinstance(msg, dict) and "metadata" not in msg:
                # Mutate the message in place so `Turn.from_state_message`
                # picks the metadata up. The executor lifts it onto
                # `Turn.metadata` and Geny's STMHandle round-trips
                # it through the jsonl.
                msg["metadata"] = dict(metadata)

        state.metadata["_stm_recorded_count"] = len(state.messages)


def _fresh_from_template(hint: Dict[str, Any]) -> Dict[str, Any] | None:
    """Build a new InteractionEvent metadata dict using *hint* as a
    template for kind / direction / counterpart_* and a fresh
    ``event_id`` (cycle 20260501_2 F1).

    Returns ``None`` if the import or coercion fails — caller treats
    that as "no metadata" and records the line plainly. We deliberately
    do not partially copy — either the new event has all five
    canonical dimensions or it has none.
    """
    try:
        from service.memory.interaction_event import (
            CounterpartRole,
            Direction,
            Kind,
            make_event_metadata,
        )

        kind_v = hint.get("kind")
        dir_v = hint.get("direction")
        cp_id = hint.get("counterpart_id")
        cp_role = hint.get("counterpart_role")
        if not (kind_v and dir_v and cp_id and cp_role):
            return None
        return make_event_metadata(
            kind=Kind(kind_v),
            direction=Direction(dir_v),
            counterpart_id=cp_id,
            counterpart_role=CounterpartRole(cp_role),
            linked_event_id=hint.get("linked_event_id"),
            payload=hint.get("payload") if isinstance(hint.get("payload"), dict) else None,
        )
    except Exception:
        logger.debug(
            "GenyDedupeStrategy: _fresh_from_template failed", exc_info=True,
        )
        return None
