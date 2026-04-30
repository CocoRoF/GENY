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


# ---------------------------------------------------------------------------
# Incoming DM classification (cycle 20260430_2 A3)
# ---------------------------------------------------------------------------

# Header that ``_trigger_dm_response`` puts on top of every recipient
# invoke prompt. Parsing it gives us the sender's session id without
# any new wiring; the rest of the prompt body is the DM content.
import re as _re

_INCOMING_DM_HEADER = _re.compile(
    r"^\[SYSTEM\] You received a direct message from "
    r"(?P<name>[^(]+)\(session:\s*(?P<sid>[^)]+)\)",
    _re.IGNORECASE,
)
_INBOX_HEADER = _re.compile(r"^\[INBOX from (?P<name>[^\]]+)\]")
_SUBWORKER_RESULT_PREFIX = "[SUB_WORKER_RESULT]"


def dm_kind_for_recipient(
    *,
    sender_agent,
    recorder_agent,
    body: str,
):
    """Resolve (kind, counterpart_role) for a DM seen on the recipient side.

    Mirror of ``_classify_outgoing_dm`` (cycle 20260430_2 A2) — same
    relationship, viewed from the receiving end:

      * recorder = Sub-Worker, sender = bound VTuber → either a
        ``TASK_REQUEST`` (the sender's perspective is "I'm asking
        you to do this") or a plain ``DM`` for chatter, mirroring
        the sender-side mapping. The asymmetric ``TASK_REQUEST``
        always travels VTuber → Sub-Worker direction.
      * recorder = VTuber, sender = bound Sub-Worker, body opens
        ``[SUB_WORKER_RESULT]`` → ``TASK_RESULT``. The named kind
        is direction-agnostic (mirrors the sender-side classifier
        from A2).
      * recorder = VTuber, sender = bound Sub-Worker, plain body
        → ``DM`` (paired channel chatter; rare).
      * any other shape → ``DM`` + ``PEER``.

    Pure / never raises — missing ``_session_type`` collapses the
    case to ``DM`` + ``PEER``.
    """
    sender_type = getattr(sender_agent, "_session_type", None)
    recorder_type = getattr(recorder_agent, "_session_type", None)
    sender_linked = getattr(sender_agent, "_linked_session_id", None)
    recorder_id = getattr(recorder_agent, "_session_id", None)
    is_paired = bool(sender_linked) and (sender_linked == recorder_id)

    if is_paired and sender_type == "vtuber" and recorder_type == "sub":
        # VTuber asked us to do something. Same TASK_REQUEST kind as
        # the sender-side mapping in A2.
        return Kind.TASK_REQUEST, CounterpartRole.PAIRED_VTUBER
    if is_paired and sender_type == "sub" and recorder_type == "vtuber":
        if body.lstrip().startswith(_SUBWORKER_RESULT_PREFIX):
            return Kind.TASK_RESULT, CounterpartRole.PAIRED_SUBWORKER
        return Kind.DM, CounterpartRole.PAIRED_SUBWORKER
    return Kind.DM, CounterpartRole.PEER


def infer_input_metadata(
    *,
    input_text: str,
    recorder_agent,
    role: str,
) -> Optional[Dict[str, Any]]:
    """Best-effort metadata for a record_message call when the caller
    didn't pass an explicit ``source_metadata``.

    Parses well-known prompt prefixes (``[SYSTEM] You received...``
    from the DM trigger; ``[INBOX from X]`` from the drain path)
    and looks up the sender via the agent manager. Returns ``None``
    when the role / shape isn't one A3 handles — A5 (reflection),
    A6 (user_chat) fill the gaps with explicit source_metadata.

    The helper imports the agent manager lazily to keep
    ``service.memory.interaction_event`` free of circular deps.
    """
    # Cycle 20260430_2 A6 — user-side chat input. The recorder is the
    # session whose ``_invoke_pipeline`` is running, and whoever owns
    # that session is the counterpart we converse with.
    if role == "user":
        owner = getattr(recorder_agent, "_owner_username", None)
        return make_event_metadata(
            kind=Kind.USER_CHAT,
            direction=Direction.IN,
            counterpart_id=canonical_user_id(owner),
            counterpart_role=CounterpartRole.USER,
        )

    if role != "assistant_dm":
        return None

    head = input_text.lstrip()

    sender_id: Optional[str] = None
    body = input_text

    m_dm = _INCOMING_DM_HEADER.match(head)
    m_inbox = _INBOX_HEADER.match(head)
    if m_dm:
        sender_id = m_dm.group("sid").strip()
        # Strip both the [SYSTEM]... block and the [DM from ...]: prefix
        # so `body` begins at the actual DM content. This matters because
        # `dm_kind_for_recipient` peeks at the leading [SUB_WORKER_RESULT]
        # token to flip kind=task_result.
        dm_marker = "[DM from"
        idx = head.find(dm_marker)
        if idx >= 0:
            colon = head.find("]:", idx)
            body = head[colon + 2:].lstrip() if colon >= 0 else head[idx:]
    elif m_inbox:
        # Inbox-drain wrappers don't carry a session id; fall back
        # to the sender_name. We can still set kind=DM, but the
        # counterpart_id won't resolve to a session — we use the
        # sender_name as a soft id.
        name = m_inbox.group("name").strip()
        sender_id = name
        nl = head.find("\n")
        body = head[nl + 1:] if nl >= 0 else head
    else:
        return None

    try:
        from service.executor import get_agent_session_manager
        manager = get_agent_session_manager()
    except Exception:
        manager = None

    sender_agent = None
    if manager is not None and sender_id:
        try:
            sender_agent = manager.get_agent(sender_id) or manager.resolve_session(sender_id)
        except Exception:
            sender_agent = None

    if sender_agent is None:
        # Couldn't resolve — emit a minimal PEER + DM record so at
        # least the dimension is present.
        return make_event_metadata(
            kind=Kind.DM,
            direction=Direction.IN,
            counterpart_id=sender_id or "unknown",
            counterpart_role=CounterpartRole.PEER,
        )

    kind, role_enum = dm_kind_for_recipient(
        sender_agent=sender_agent,
        recorder_agent=recorder_agent,
        body=body,
    )
    return make_event_metadata(
        kind=kind,
        direction=Direction.IN,
        counterpart_id=sender_id,
        counterpart_role=role_enum,
    )
