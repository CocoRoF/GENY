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
    "SpotlightItem",
    "ViewEventType",
    "ViewKey",
    "ViewRecord",
    "ViewLedger",
    "ViewLedgerSnapshot",
    "get_view_ledger",
    "parse_capture_type",
    "parse_view_event_type",
]
