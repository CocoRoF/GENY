"""
Whiteboard service — Phase 0 foundation.

Provides:
  - `types`: CaptureEvent / SpotlightItem / ViewKey / ViewRecord (data model)
  - `view_ledger`: per-(agent, note) view tracking with 5-event-type counts
  - `attachments`: binary attachment storage helpers under a user vault

Phase 0 scope is data model + storage scaffolding only — the active
ingestion endpoint and tool integrations land in P1+ (controller is
exposed in P0 but is read/write capable so the model can be exercised).

See: ``docs/knowledge-whiteboard/`` for full architecture and plan.
"""

from .agent_resolver import resolve_user_and_agent
from .spotlight_context import (
    PERSONA_GUIDANCE as SPOTLIGHT_PERSONA_GUIDANCE,
    render_spotlight_section,
)
from .spotlight_store import (
    DEFAULT_TTL_MINUTES,
    SpotlightStore,
    get_spotlight_store,
)
from .types import (
    CaptureEvent,
    CapturePayload,
    CaptureType,
    SpotlightItem,
    ViewEventType,
    ViewKey,
    ViewRecord,
    parse_capture_type,
    parse_view_event_type,
)
from .view_ledger import (
    ViewLedger,
    ViewLedgerSnapshot,
    get_view_ledger,
)

__all__ = [
    "CaptureEvent",
    "CapturePayload",
    "CaptureType",
    "DEFAULT_TTL_MINUTES",
    "SPOTLIGHT_PERSONA_GUIDANCE",
    "SpotlightItem",
    "SpotlightStore",
    "ViewEventType",
    "ViewKey",
    "ViewLedger",
    "ViewLedgerSnapshot",
    "ViewRecord",
    "get_spotlight_store",
    "get_view_ledger",
    "parse_capture_type",
    "parse_view_event_type",
    "render_spotlight_section",
    "resolve_user_and_agent",
]
