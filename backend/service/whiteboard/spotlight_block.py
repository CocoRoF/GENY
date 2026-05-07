"""
SpotlightContextBlock — PromptBlock that injects active spotlight items
into the system prompt on every turn.

Wired into the per-session tail-block list inside
``service.executor.agent_session.AgentSession`` so any session that
gets a DynamicPersonaSystemBuilder also gets spotlight awareness for
free. Renders empty when the user has no active spotlights, so the
block is safe to install unconditionally.

The block is a thin adapter around :func:`render_spotlight_section`
— all formatting / view-meta decoration / image-ref collection
already lives there, this is just the plumbing into ``PromptBlock``.
"""

from __future__ import annotations

from logging import getLogger

from geny_executor.core.state import PipelineState
from geny_executor.stages.s03_system.interface import PromptBlock

from .spotlight_context import (
    PERSONA_GUIDANCE as SPOTLIGHT_PERSONA_GUIDANCE,
    render_spotlight_section,
)

logger = getLogger(__name__)


class SpotlightContextBlock(PromptBlock):
    """Per-turn spotlight section. Empty when nothing is shared.

    Position: install just before ``MemoryContextBlock`` so the model
    sees the user's "right now" focus immediately after the persona
    and identity blocks but ahead of the heavier memory recall.
    """

    @property
    def name(self) -> str:
        return "whiteboard_spotlight"

    def render(self, state: PipelineState) -> str:
        session_id = getattr(state, "session_id", "") or ""
        if not session_id:
            return ""
        try:
            result = render_spotlight_section(session_id)
        except Exception:  # noqa: BLE001
            logger.debug("SpotlightContextBlock render failed", exc_info=True)
            return ""
        text = result.get("text") or ""
        if not text:
            return ""
        # Append the persona guidance only when there ARE active items
        # — otherwise the model sees a guidance line about a section
        # that doesn't exist this turn, which can confuse small models.
        return f"{text}\n\n{SPOTLIGHT_PERSONA_GUIDANCE}"
