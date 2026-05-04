"""Memory subsystem event emitter — bridge to the per-session log channel.

The legacy `service.memory` writers (`StructuredMemoryWriter`,
`VectorMemoryManager`, `CuratedKnowledgeManager`, …) live below the
`AgentSession` layer and don't import the agent manager directly —
that would create a cycle. Instead they emit memory events through
this helper, which performs a lazy lookup against the live
`AgentSessionManager`. The agent then routes the event into the
session's `SessionLogger` (or parks it on its pending list when the
logger has not been provisioned yet).

`session_id` here is whatever the writer was constructed with — it
mirrors `AgentSession.session_id` for per-session writers and falls
back to a synthetic ``user:<username>`` / ``curated:<username>`` for
cross-session vaults. Cross-session writers don't have a matching
agent, so the lookup returns ``None`` and the helper silently skips
— that is the right behaviour: those writes belong to a vault, not
to a single conversational turn.

Failures inside the lookup or routing path are swallowed at DEBUG
because vault writes must never fail because of a logging side
effect.
"""

from __future__ import annotations

from logging import getLogger
from typing import Any, Dict, Optional

logger = getLogger(__name__)


def emit_memory_event(
    session_id: Optional[str],
    *,
    event_type: str,
    message: str,
    source: str = "Memory",
    layer: Optional[str] = None,
    backend: Optional[str] = None,
    engine: Optional[str] = None,
    importance: Optional[str] = None,
    category: Optional[str] = None,
    path: Optional[str] = None,
    chars: Optional[int] = None,
    chunks: Optional[int] = None,
    score: Optional[float] = None,
    duration_ms: Optional[int] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> None:
    """Forward a memory event to the matching `AgentSession`.

    Best-effort. Any failure (no agent registered, agent without
    `record_memory_event`, manager unavailable) returns silently —
    the writer's primary side effect (markdown / vector row) has
    already happened by the time this is called.
    """
    if not session_id:
        return
    if session_id.startswith(("user:", "curated:", "global:")):
        # Cross-session vault writes have no enclosing turn / panel
        # to surface to. Skip the lookup outright to keep the hot path
        # cheap.
        return
    try:
        from service.executor.agent_session_manager import agent_manager

        agent = agent_manager.get_agent(session_id)
        if agent is None:
            return
        recorder = getattr(agent, "record_memory_event", None)
        if recorder is None:
            return
        recorder(
            event_type=event_type,
            message=message,
            source=source,
            layer=layer,
            backend=backend,
            engine=engine,
            importance=importance,
            category=category,
            path=path,
            chars=chars,
            chunks=chunks,
            score=score,
            duration_ms=duration_ms,
            extra=extra,
        )
    except Exception:  # noqa: BLE001
        logger.debug(
            "emit_memory_event: routing skipped (session_id=%s)",
            session_id,
            exc_info=True,
        )


__all__ = ["emit_memory_event"]
