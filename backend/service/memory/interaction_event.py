"""InteractionEvent — canonical metadata schema for VTuber's life history.

Cycle 20260430_2 introduces a unified mental model where *every*
interaction the VTuber has — talking with the user, sending tasks
to its paired Sub-Worker, observing what the Sub-Worker did,
internal reflection — is treated as one entry in a single stream of
``InteractionEvent`` objects.

The stream lives **inside the existing STM** (no new store): each
``ShortTermMemory.add_message`` call carries this dict in its
``metadata`` argument. Read-side retrieval (Geny memory retriever's
recent_turns / vector / keyword layers) keeps working unchanged —
the metadata only enriches what is already there.

Design invariants pinned by every PR in this cycle (see
``dev_docs/20260430_2/plan/cycle_plan.md``):

1. All InteractionEvents live inside STM metadata — no new store.
2. Every recording hook fills metadata — no empty ``{}``.
3. Every tool sees only the caller's own memory — no cross-session.
4. Zero bytes of prompt-side data injection.

Usage::

    from service.memory.interaction_event import (
        Direction, Kind, CounterpartRole, make_event_metadata,
        canonical_user_id, parse_event_metadata,
    )

    metadata = make_event_metadata(
        kind=Kind.TASK_REQUEST,
        direction=Direction.OUT,
        counterpart_id="sub-1",
        counterpart_role=CounterpartRole.PAIRED_SUBWORKER,
    )
    memory_manager.record_message("assistant_dm", body, metadata=metadata)

The schema is backwards-compatible: any old jsonl line whose
``metadata`` is missing or empty parses to ``None`` from
``parse_event_metadata`` — callers can safely treat it as a
"pre-unification" entry.
"""

from __future__ import annotations

import uuid
from enum import Enum
from typing import Any, Dict, Optional


class Kind(str, Enum):
    """Categorical kind of an InteractionEvent.

    Forward-compat: new kinds are added at the end. Consumers must
    treat unknown ``kind`` strings as opaque (do not assert on
    membership).
    """
    USER_CHAT        = "user_chat"          # ordinary turn with the human user
    DM               = "dm"                  # plain DM with any counterpart
    TASK_REQUEST     = "task_request"        # VTuber → paired Sub-Worker task
    TASK_RESULT      = "task_result"         # paired Sub-Worker's [SUB_WORKER_RESULT]
    TOOL_RUN_SUMMARY = "tool_run_summary"    # categorised SubWorkerRun payload
    REFLECTION       = "reflection"          # THINKING_TRIGGER / ACTIVITY_TRIGGER
    SYSTEM_NOTE      = "system_note"         # runtime self-note (revival, schema migration, …)


class Direction(str, Enum):
    """Whether the event flowed *into* the recording session, *out of*
    it, or stayed *internal* (self-prompted reflection).
    """
    IN       = "in"
    OUT      = "out"
    INTERNAL = "internal"


class CounterpartRole(str, Enum):
    """Role of the *other* party in this event from the recorder's
    perspective. The string values are stable and are persisted on
    disk — never rename them.

    ``PAIRED_SUBWORKER`` and ``PAIRED_VTUBER`` are mirror values: the
    bound counterpart's role flips depending on which side is doing
    the recording. A VTuber recording its bound Sub-Worker uses
    ``PAIRED_SUBWORKER``; the same DM recorded on the Sub-Worker's
    own STM uses ``PAIRED_VTUBER``. Together they preserve the "I am
    talking to my paired counterpart" relationship from both ends.
    """
    USER             = "user"               # human user
    PAIRED_SUBWORKER = "paired_subworker"   # recorder is VTuber, target is bound Sub-Worker
    PAIRED_VTUBER    = "paired_vtuber"      # recorder is Sub-Worker, target is bound VTuber
    PEER             = "peer"               # any other live session
    SELF             = "self"               # reflection / system_note
    SYSTEM           = "system"             # the runtime itself


# ---------------------------------------------------------------------------
# Canonical id helpers
# ---------------------------------------------------------------------------


def canonical_user_id(owner_username: Optional[str]) -> str:
    """Stable counterpart_id for the human user side of a session.

    Empty / None usernames map to ``owner:unknown`` so retrieval
    queries never crash on a missing owner — they just won't match
    anything specific.
    """
    name = (owner_username or "").strip()
    return f"owner:{name}" if name else "owner:unknown"


def new_event_id() -> str:
    """Return a fresh event id.

    First PR uses uuid4; once we settle on a ULID dependency the
    helper is the single point of swap (every emitter calls it).
    Callers must treat the result as opaque.
    """
    return uuid.uuid4().hex


# ---------------------------------------------------------------------------
# Builder
# ---------------------------------------------------------------------------

# Keys reserved by InteractionEvent inside the metadata dict. ``payload``
# is included so callers can build it through this helper without
# accidentally clobbering an existing field.
_RESERVED_KEYS = frozenset({
    "event_id",
    "kind",
    "direction",
    "counterpart_id",
    "counterpart_role",
    "linked_event_id",
    "payload",
})


def make_event_metadata(
    *,
    kind: Kind,
    direction: Direction,
    counterpart_id: str,
    counterpart_role: CounterpartRole,
    linked_event_id: Optional[str] = None,
    payload: Optional[Dict[str, Any]] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Build the canonical metadata dict for ``ShortTermMemory.add_message``.

    Args:
        kind: One of :class:`Kind`.
        direction: One of :class:`Direction`.
        counterpart_id: Canonical id of the other party. Use
            :func:`canonical_user_id` for the human user, the bound
            session id for paired/peer agents, and the literals
            ``"self"`` / ``"system"`` for internal events.
        counterpart_role: One of :class:`CounterpartRole`.
        linked_event_id: Optional reference to a parent event in the
            same stream — e.g. a ``TOOL_RUN_SUMMARY`` linking back to
            the originating ``TASK_REQUEST``.
        payload: Optional kind-specific structured data (must be
            JSON-serialisable). Examples: tool_run_summary categorised
            buckets, reflection trigger_category, dm task_id.
        extra: Optional free-form fields the caller wants to preserve
            *outside* the InteractionEvent namespace. Useful for
            backwards-compatible additions (e.g. legacy STM metadata
            already in use). Reserved keys cannot be used here — a
            ``ValueError`` is raised so callers don't silently
            shadow the schema.

    Returns:
        A new dict ready to be passed as ``metadata=...`` to
        ``record_message`` / ``add_message``.

    Raises:
        ValueError: when *extra* contains a reserved key.
    """
    if extra:
        clash = set(extra) & _RESERVED_KEYS
        if clash:
            raise ValueError(
                "extra metadata cannot use reserved InteractionEvent "
                f"keys: {sorted(clash)}"
            )

    meta: Dict[str, Any] = {
        "event_id": new_event_id(),
        "kind": kind.value,
        "direction": direction.value,
        "counterpart_id": counterpart_id,
        "counterpart_role": counterpart_role.value,
    }
    if linked_event_id:
        meta["linked_event_id"] = linked_event_id
    if payload:
        # Defensive copy so the caller's mutations don't leak in.
        meta["payload"] = dict(payload)
    if extra:
        meta.update(extra)
    return meta


# ---------------------------------------------------------------------------
# Parser (backwards-compat read side)
# ---------------------------------------------------------------------------


class InteractionEventView:
    """Read-only view over a parsed InteractionEvent.

    Kept as a regular class (not a frozen dataclass) so it can be
    cheaply constructed from a dict without copying the payload
    sub-dict. ``metadata`` returns the original dict unchanged —
    consumers must not mutate it.
    """

    __slots__ = ("_meta",)

    def __init__(self, meta: Dict[str, Any]) -> None:
        self._meta = meta

    @property
    def event_id(self) -> str:
        return str(self._meta["event_id"])

    @property
    def kind(self) -> str:
        return str(self._meta["kind"])

    @property
    def direction(self) -> str:
        return str(self._meta["direction"])

    @property
    def counterpart_id(self) -> str:
        return str(self._meta["counterpart_id"])

    @property
    def counterpart_role(self) -> str:
        return str(self._meta["counterpart_role"])

    @property
    def linked_event_id(self) -> Optional[str]:
        v = self._meta.get("linked_event_id")
        return str(v) if v else None

    @property
    def payload(self) -> Dict[str, Any]:
        p = self._meta.get("payload")
        return p if isinstance(p, dict) else {}

    @property
    def metadata(self) -> Dict[str, Any]:
        return self._meta


def parse_event_metadata(
    meta: Optional[Dict[str, Any]],
) -> Optional[InteractionEventView]:
    """Return an :class:`InteractionEventView` if *meta* carries the
    canonical InteractionEvent fields, otherwise ``None``.

    Pre-unification jsonl lines (which lack the schema) parse to
    ``None`` so callers can fall through to legacy handling without
    branching on missing keys.
    """
    if not meta or not isinstance(meta, dict):
        return None
    required = ("event_id", "kind", "direction", "counterpart_id", "counterpart_role")
    if not all(k in meta and meta[k] is not None for k in required):
        return None
    return InteractionEventView(meta)
