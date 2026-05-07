"""
agent_resolver — derive ``(username, agent_id)`` from a session id.

Knowledge tools and the spotlight context section both need the
``ViewLedger`` keyed on ``(agent_id, note_id)``.  ``session_id`` is
not the right key — multiple sessions can share the same persona /
character and we want their "seen memory" to combine, not split.

The order of preference for ``agent_id`` is:

  1. ``character_display_name`` (when set on the session)
  2. ``role`` (e.g. ``"VTuber"`` / ``"Worker"``)
  3. literal ``"default"``

Returning ``None`` for either field means "skip the ledger" — callers
must treat that as best-effort and never raise from a missing user.
"""

from __future__ import annotations

from logging import getLogger
from typing import Optional, Tuple

logger = getLogger(__name__)


def resolve_user_and_agent(session_id: str) -> Tuple[Optional[str], Optional[str]]:
    """Return ``(username, agent_id)`` for the given session.

    Best-effort: any failure returns ``(None, None)``.
    """
    if not session_id:
        return (None, None)
    try:
        from service.executor.agent_session_manager import agent_manager  # type: ignore
    except Exception:  # noqa: BLE001
        return (None, None)
    try:
        agent = agent_manager.get_agent(session_id)
    except Exception:  # noqa: BLE001
        return (None, None)
    if agent is None:
        return (None, None)
    username = getattr(agent, "owner_username", None) or None
    agent_id = (
        getattr(agent, "character_display_name", None)
        or getattr(agent, "role", None)
        or "default"
    )
    return (username, agent_id or "default")
