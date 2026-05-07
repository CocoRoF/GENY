"""
Whiteboard data model — Phase 0.

Single source of truth for:
  - `CaptureEvent` / `CapturePayload`: every input source (screen / clipboard
    / file / future audio / drawing) converges on this shape before reaching
    the Inbox or any analysis pipeline.
  - `SpotlightItem`: an item the user has shared with the VTuber for
    immediate, ephemeral focus (added to the system prompt for N turns).
  - `ViewKey` / `ViewRecord` / `ViewEventType`: the agent's "seen memory" —
    per (agent_id, note_id), 5 event-type counters (`searched`, `listed`,
    `read`, `injected`, `mentioned`).

The `audio` and `drawing` capture types are present in the enum from P0
to keep the data model future-stable (the docs §11.2 promise) — the
processing pipelines for those land in later phases.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, FrozenSet, Iterable, Literal, Optional, Tuple


# ── Capture types ─────────────────────────────────────────────────────

CaptureType = Literal[
    "text",
    "image",
    "screenshot",
    "audio",        # P0 enum-only, processing in backlog
    "drawing",      # P0 enum-only, processing in backlog
    "link",
    "file",
    "code",
]

_VALID_CAPTURE_TYPES: FrozenSet[str] = frozenset(
    {"text", "image", "screenshot", "audio", "drawing", "link", "file", "code"}
)


def parse_capture_type(raw: str) -> CaptureType:
    """Validate and narrow ``raw`` to a CaptureType.

    Raises ``ValueError`` if the type is unknown — controllers must
    surface this as a 400, never coerce silently.
    """
    if raw not in _VALID_CAPTURE_TYPES:
        raise ValueError(
            f"unknown capture type: {raw!r}; expected one of "
            + ", ".join(sorted(_VALID_CAPTURE_TYPES))
        )
    return raw  # type: ignore[return-value]


@dataclass(slots=True)
class CapturePayload:
    """Exactly one of these fields is populated per CaptureEvent.

    Kept separate from ``CaptureEvent`` so payload shape can vary
    independently of the event metadata.
    """

    inline_text: Optional[str] = None
    attachment_path: Optional[str] = None  # relative path under _attachments/
    inline_base64: Optional[str] = None    # small images only
    ref_url: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "inline_text": self.inline_text,
            "attachment_path": self.attachment_path,
            "inline_base64": self.inline_base64,
            "ref_url": self.ref_url,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "CapturePayload":
        return cls(
            inline_text=data.get("inline_text"),
            attachment_path=data.get("attachment_path"),
            inline_base64=data.get("inline_base64"),
            ref_url=data.get("ref_url"),
        )

    def is_empty(self) -> bool:
        return not any(
            (self.inline_text, self.attachment_path, self.inline_base64, self.ref_url)
        )


@dataclass(slots=True)
class CaptureEvent:
    """A single piece of incoming whiteboard data, normalised."""

    capture_id: str
    type: CaptureType
    source: str                        # "screen_capture" | "clipboard" | "browser" | "manual" | ...
    payload: CapturePayload
    user_id: str
    metadata: Dict[str, Any] = field(default_factory=dict)
    session_id: Optional[str] = None
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> Dict[str, Any]:
        return {
            "capture_id": self.capture_id,
            "type": self.type,
            "source": self.source,
            "payload": self.payload.to_dict(),
            "user_id": self.user_id,
            "metadata": dict(self.metadata),
            "session_id": self.session_id,
            "created_at": self.created_at.isoformat(),
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "CaptureEvent":
        created_raw = data.get("created_at")
        created = (
            datetime.fromisoformat(created_raw)
            if isinstance(created_raw, str)
            else datetime.now(timezone.utc)
        )
        return cls(
            capture_id=str(data["capture_id"]),
            type=parse_capture_type(str(data["type"])),
            source=str(data.get("source") or "manual"),
            payload=CapturePayload.from_dict(data.get("payload") or {}),
            user_id=str(data["user_id"]),
            metadata=dict(data.get("metadata") or {}),
            session_id=data.get("session_id"),
            created_at=created,
        )


# ── Spotlight ─────────────────────────────────────────────────────────


@dataclass(slots=True)
class SpotlightItem:
    """An item the user has shared for immediate VTuber attention.

    ``source_filename`` points into the user's Opsidian vault (or a
    Curated note when shared in `library` mode and pinned). The item is
    rendered in the VTuber system prompt while active and cleared when
    its TTL expires or the user dismisses it.
    """

    item_id: str
    user_id: str
    session_id: Optional[str]
    source_filename: str
    title: str
    excerpt: str
    attachments: Tuple[str, ...] = ()
    capture_id: Optional[str] = None
    note_kind: Literal["user", "curated"] = "user"
    expires_at: Optional[datetime] = None
    pinned: bool = False
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "item_id": self.item_id,
            "user_id": self.user_id,
            "session_id": self.session_id,
            "source_filename": self.source_filename,
            "title": self.title,
            "excerpt": self.excerpt,
            "attachments": list(self.attachments),
            "capture_id": self.capture_id,
            "note_kind": self.note_kind,
            "expires_at": self.expires_at.isoformat() if self.expires_at else None,
            "pinned": self.pinned,
            "created_at": self.created_at.isoformat(),
            "metadata": dict(self.metadata),
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "SpotlightItem":
        def _parse_dt(value: Any) -> Optional[datetime]:
            if isinstance(value, str) and value:
                try:
                    return datetime.fromisoformat(value)
                except ValueError:
                    return None
            return None

        attachments_raw: Iterable[Any] = data.get("attachments") or ()
        return cls(
            item_id=str(data["item_id"]),
            user_id=str(data["user_id"]),
            session_id=data.get("session_id"),
            source_filename=str(data["source_filename"]),
            title=str(data.get("title") or ""),
            excerpt=str(data.get("excerpt") or ""),
            attachments=tuple(str(a) for a in attachments_raw),
            capture_id=data.get("capture_id"),
            note_kind=data.get("note_kind") or "user",  # type: ignore[arg-type]
            expires_at=_parse_dt(data.get("expires_at")),
            pinned=bool(data.get("pinned") or False),
            created_at=_parse_dt(data.get("created_at")) or datetime.now(timezone.utc),
            metadata=dict(data.get("metadata") or {}),
        )

    def is_expired(self, now: Optional[datetime] = None) -> bool:
        if self.pinned or self.expires_at is None:
            return False
        ts = now or datetime.now(timezone.utc)
        return ts >= self.expires_at


# ── ViewLedger types ──────────────────────────────────────────────────

ViewEventType = Literal[
    "searched",   # appeared in a search hit list (weak signal)
    "listed",     # appeared in a list metadata response (weak signal)
    "read",       # body fetched (strong signal)
    "injected",   # rendered into the system prompt (strong signal)
    "mentioned",  # observed in the agent's response text (heuristic, P4+)
]

_VALID_VIEW_EVENT_TYPES: FrozenSet[str] = frozenset(
    {"searched", "listed", "read", "injected", "mentioned"}
)

VIEW_EVENT_TYPES: Tuple[ViewEventType, ...] = (
    "searched",
    "listed",
    "read",
    "injected",
    "mentioned",
)


def parse_view_event_type(raw: str) -> ViewEventType:
    if raw not in _VALID_VIEW_EVENT_TYPES:
        raise ValueError(
            f"unknown view event type: {raw!r}; expected one of "
            + ", ".join(sorted(_VALID_VIEW_EVENT_TYPES))
        )
    return raw  # type: ignore[return-value]


@dataclass(frozen=True, slots=True)
class ViewKey:
    """Per-agent, per-note identity used by the ledger.

    ``agent_id`` separation is required so multiple personas / characters
    in the same project keep their "seen memory" isolated.
    """

    agent_id: str
    note_id: str

    def to_tuple(self) -> Tuple[str, str]:
        return (self.agent_id, self.note_id)


@dataclass(slots=True)
class ViewRecord:
    """Per-key view history with separate counts for each event type."""

    key: ViewKey
    first_seen_at: datetime
    last_seen_at: datetime
    counts: Dict[ViewEventType, int] = field(default_factory=dict)
    last_event: Optional[ViewEventType] = None
    last_context: Optional[str] = None

    def total(self) -> int:
        return sum(self.counts.values())

    def has_seen(self) -> bool:
        return self.total() > 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "agent_id": self.key.agent_id,
            "note_id": self.key.note_id,
            "first_seen_at": self.first_seen_at.isoformat(),
            "last_seen_at": self.last_seen_at.isoformat(),
            "counts": dict(self.counts),
            "last_event": self.last_event,
            "last_context": self.last_context,
        }

    @classmethod
    def empty(cls, key: ViewKey, now: Optional[datetime] = None) -> "ViewRecord":
        ts = now or datetime.now(timezone.utc)
        return cls(key=key, first_seen_at=ts, last_seen_at=ts, counts={})

    def view_meta(self, *, now: Optional[datetime] = None) -> Dict[str, Any]:
        """Compact summary for decoration onto knowledge tool results."""
        seen = self.has_seen()
        return {
            "seen": seen,
            "counts": {k: int(v) for k, v in self.counts.items()},
            "first_seen_at": self.first_seen_at.isoformat() if seen else None,
            "last_seen_at": self.last_seen_at.isoformat() if seen else None,
            "last_event": self.last_event,
        }
