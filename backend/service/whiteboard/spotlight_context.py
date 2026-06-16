"""
SpotlightContextSection — render active spotlight items into a system
prompt fragment, decorated with ViewLedger ``⚑`` hints.

Phase 2a delivers the rendering function that any prompt builder /
persona system can call.  Phase 2b will wire this into
``DynamicPersonaSystemBuilder`` (so the section automatically appears
in every VTuber turn) — until then, manual integration is one call
to :func:`render_spotlight_section`.

The section emits *plain text* by default.  When the caller knows
the model supports vision, they can pass ``vision_capable=True`` to
get back a list of "content blocks" (text + image references) suitable
for vision-capable model APIs.
"""

from __future__ import annotations

from datetime import datetime, timezone
from logging import getLogger
from typing import Any, Dict, List, Optional, Sequence

from .agent_resolver import resolve_user_and_agent
from .spotlight_store import get_spotlight_store
from .types import SpotlightItem
from .view_ledger import get_view_ledger

logger = getLogger(__name__)


# Persona guidance that pairs with the section. Callers should append
# this once to the persona block (P2b automates this).
PERSONA_GUIDANCE = (
    "When the system prompt contains a [Spotlight Context] block, "
    "treat each item with a ⚑ 'previously seen' hint as continuing "
    "an earlier conversation: do not introduce it as if it were "
    "brand new. Items marked '처음 보는 자료 / first time' are "
    "genuinely new — acknowledge them explicitly and ask whether the "
    "user wants you to discuss them."
)


def _humanise_when(value: Optional[datetime], *, now: Optional[datetime] = None) -> str:
    if value is None:
        return ""
    ts = now or datetime.now(timezone.utc)
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    diff = (ts - value).total_seconds()
    if diff < 60:
        return "just now"
    if diff < 3600:
        return f"{int(diff // 60)} min ago"
    if diff < 86400:
        return f"{int(diff // 3600)} h ago"
    return f"{int(diff // 86400)} d ago"


def _seen_hint(view_meta: Dict[str, Any]) -> str:
    """Compose the human-readable ⚑ hint from a ViewLedger meta block."""
    if not view_meta or not view_meta.get("seen"):
        return "⚑ first time / 처음 보는 자료"
    counts = view_meta.get("counts") or {}
    parts: List[str] = []
    for label_key in ("read", "injected", "searched"):
        n = int(counts.get(label_key, 0) or 0)
        if n:
            parts.append(f"{n}× {label_key}")
    suffix = ""
    last_seen = view_meta.get("last_seen_at")
    if isinstance(last_seen, str):
        try:
            ts = datetime.fromisoformat(last_seen)
            suffix = f" / last {_humanise_when(ts)}"
        except ValueError:
            pass
    if parts:
        return f"⚑ previously seen — {', '.join(parts)}{suffix}"
    return f"⚑ previously seen{suffix}"


def render_spotlight_section(
    session_id: str,
    *,
    items: Optional[Sequence[SpotlightItem]] = None,
    vision_capable: bool = False,
    record_injection: bool = True,
) -> Dict[str, Any]:
    """Build the system-prompt section for the session's active spotlights.

    Returns a dict with two keys:
      * ``"text"``  — the rendered text block (always present, may be ``""``).
      * ``"images"`` — list of attachment paths if ``vision_capable`` is True
        AND any spotlight item has image attachments. Empty list otherwise.

    Side-effect: when ``record_injection`` is True, every rendered item
    gets one ``injected`` event in the per-(user, agent) ViewLedger.
    Set ``record_injection=False`` for previews / debug renders.
    """
    username, agent_id = resolve_user_and_agent(session_id)
    if items is None:
        if not username:
            # No user → no spotlight bucket to read.
            return {"text": "", "images": []}
        store = get_spotlight_store()
        items = store.list(user_id=username, session_id=session_id)
    if not items:
        return {"text": "", "images": []}

    ledger = (
        get_view_ledger(username, agent_id)
        if (username and agent_id)
        else None
    )

    lines: List[str] = []
    image_refs: List[str] = []
    for idx, item in enumerate(items, start=1):
        view_meta = (
            ledger.view_meta(item.source_filename) if ledger else {"seen": False}
        )
        when = _humanise_when(item.created_at)
        lines.append(
            f"{idx}. [{item.note_kind}] \"{item.title}\""
            f" (shared {when})"
        )
        lines.append(f"    {_seen_hint(view_meta)}")
        excerpt = (item.excerpt or "").strip()
        if excerpt:
            short = excerpt if len(excerpt) <= 320 else excerpt[:317] + "…"
            lines.append(f"    excerpt: {short}")
        if item.attachments:
            lines.append(f"    attachments: {', '.join(item.attachments)}")
            if vision_capable:
                # Collect image-ish attachments — caller is responsible
                # for fetching the bytes via the standard attachment URL.
                for path in item.attachments:
                    lower = path.lower()
                    if any(
                        lower.endswith(ext)
                        for ext in (".png", ".jpg", ".jpeg", ".webp", ".gif")
                    ):
                        image_refs.append(path)
        if record_injection and ledger:
            try:
                ledger.record(
                    item.source_filename,
                    "injected",
                    context=f"spotlight:{item.item_id}",
                )
            except Exception:  # noqa: BLE001
                logger.debug("ViewLedger.record(injected) failed", exc_info=True)

    body = "\n".join(lines)
    text = f"[Spotlight Context]\n{body}\n[/Spotlight Context]"
    return {"text": text, "images": image_refs}
