"""Auto-bootstrap of `entities/<counterpart>.md` LTM notes.

Cycle 20260430_3 Stage B — every time the recorder writes an
InteractionEvent that names a *new* counterpart, we drop a tiny
stub note under ``entities/<sanitized>.md``. The existing
MemoryTab tree picks the file up immediately, so users see
"this counterpart's memory bucket" the moment the conversation
exists.

Cycle 20260501_2 F3 — when the file already exists, the hook no
longer bails out: it recomputes a small stats block from the
caller's STM and overwrites the body via ``writer.update_note``.
Without this refresh, the bootstrap stub ("memory_distill 을
호출하면 …") stays as the entity body forever — the user sees
that exact stub line in real deployments because they never call
the explicit ``memory_distill`` tool. The refresh is *stats-only*
— no LLM call (auto distill remains a separate cycle's scope).

This module is intentionally narrow:

  * idempotent (refresh writes the same body for the same STM tail),
  * silent on absent structured writer (test / minimal sessions),
  * skips ``self`` and ``system`` counterparts (entities is
    *external relationships*, not internal monologue),
  * never raises — best-effort.

Cycle 20260430_2 invariants preserved:

  * No prompt-side data injection (file write only — environment).
  * No new store (uses the existing structured_writer path).
  * Caller-scoped (writes only to the recorder's own LTM).
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Tuple

from service.memory.interaction_event import parse_event_metadata

logger = logging.getLogger(__name__)


_BOOTSTRAP_BODY = (
    "_(아직 distillation 이 진행되지 않았어요. "
    "`memory_distill` 을 호출하면 누적된 상호작용을 요약해 둡니다.)_\n"
)

_REFRESH_MAX_EVENTS = 256
_REFRESH_MAX_FILES = 10

# counterpart_id values that don't represent an external party — we
# never bootstrap an entity file for these.
_SKIP_COUNTERPART_IDS = frozenset({"self", "system", "", "unknown"})


def _sanitize_counterpart_for_filename(counterpart_id: str) -> str:
    """Same algorithm used by ``memory_inspect_tools.MemoryDistillTool``.

    Kept duplicated rather than imported to avoid a circular import
    (memory_inspect_tools depends on the agent manager; this module
    is called from the memory manager's record path). Both helpers
    must produce identical output — pinned by a parity test in
    ``tests/service/memory/test_entity_bootstrap.py``.
    """
    import re as _re
    cleaned = _re.sub(r"[^A-Za-z0-9_-]", "_", counterpart_id or "unknown")
    return cleaned[:80] or "unknown"


def maybe_bootstrap_entity(
    memory_manager,
    metadata: Optional[Dict[str, Any]],
) -> Optional[str]:
    """Create ``entities/<sanitized>.md`` for a fresh counterpart.

    Hook signature: pass the metadata dict that was just attached to
    a ``record_message`` call. Returns the relative path that was
    written, ``None`` for any reason that means "skip" (legacy
    metadata, self/system counterpart, file already exists, no
    structured writer, transient write error).

    The function never raises — record_message is on the hot path
    and must not fail because of an entity-stub side-effect.
    """
    try:
        view = parse_event_metadata(metadata)
        if view is None:
            return None  # Legacy / pre-cycle metadata — nothing to bootstrap

        cp_id = (view.counterpart_id or "").strip()
        if cp_id in _SKIP_COUNTERPART_IDS:
            return None
        cp_role = view.counterpart_role or ""
        if cp_role.lower() in ("self", "system"):
            return None

        writer = getattr(memory_manager, "_structured_writer", None)
        if writer is None:
            # Minimal SessionMemoryManager / unit tests — silently skip
            # so the recorder side stays free of test-only branches.
            return None

        sanitized = _sanitize_counterpart_for_filename(cp_id)
        rel_path = f"entities/{sanitized}.md"

        ltm = getattr(memory_manager, "_ltm", None)
        memory_dir = (
            getattr(writer, "memory_dir", None)
            or (getattr(ltm, "memory_dir", None) if ltm is not None else None)
        )
        file_exists = False
        if memory_dir is not None:
            try:
                full = memory_dir / rel_path
                file_exists = full.exists()
            except Exception:
                # If we can't even stat the file, fall through as if it
                # didn't exist — write_note(filename_override=...) will
                # dedupe in the worst case rather than crashing.
                file_exists = False

        # Cycle 20260501_2 F3 — file already exists → recompute stats
        # from caller's STM and refresh the body in place. Without
        # this branch, the cycle 20260430_3 stub ("memory_distill 을
        # 호출하면 …") stays forever and the user only sees a static
        # placeholder.
        if file_exists:
            return _refresh_entity_stats(
                memory_manager,
                rel_path=rel_path,
                counterpart_id=cp_id,
                counterpart_role=cp_role,
            )

        title = f"Counterpart {cp_id}"
        tags = ["entity", "bootstrap"]
        if cp_role:
            tags.append(cp_role)
        try:
            return writer.write_note(
                title=title,
                content=_BOOTSTRAP_BODY,
                category="entities",
                tags=tags,
                importance="medium",
                source="bootstrap",
                filename_override=rel_path,
            )
        except Exception:
            logger.debug(
                "entity_bootstrap: write_note failed for %s", cp_id, exc_info=True,
            )
            return None
    except Exception:
        # Truly defensive — any unexpected error means skip.
        logger.debug(
            "entity_bootstrap: unexpected failure", exc_info=True,
        )
        return None


# ─────────────────────────────────────────────────────────────────
# Cycle 20260501_2 F3 — incremental stats refresh
# ─────────────────────────────────────────────────────────────────


def _refresh_entity_stats(
    memory_manager,
    *,
    rel_path: str,
    counterpart_id: str,
    counterpart_role: Optional[str],
) -> Optional[str]:
    """Recompute stats from the caller's STM and overwrite the body
    of an existing ``entities/<sanitized>.md`` note.

    Best-effort — any failure (STM unavailable, update_note raises,
    counterpart never seen) returns ``None`` and leaves the prior
    body untouched. We deliberately *do not* re-stub: an entity file
    only enters this path because the recorder just wrote a matching
    InteractionEvent, so we expect events_seen ≥ 1.
    """
    try:
        stats = _summarise_counterpart_stats(memory_manager, counterpart_id)
        if stats is None:
            return None
        body = _render_entity_stats_body(stats, counterpart_role)
        writer = getattr(memory_manager, "_structured_writer", None)
        if writer is None:
            return None
        update = getattr(writer, "update_note", None)
        if update is None:
            return None
        try:
            ok = update(rel_path, content=body)
        except Exception:
            logger.debug(
                "entity_bootstrap: update_note raised for %s",
                rel_path, exc_info=True,
            )
            return None
        return rel_path if ok else None
    except Exception:
        logger.debug(
            "entity_bootstrap: refresh failed for %s",
            counterpart_id, exc_info=True,
        )
        return None


def _summarise_counterpart_stats(
    memory_manager, counterpart_id: str,
) -> Optional[Dict[str, Any]]:
    """Walk the caller's STM tail-first and aggregate up to
    ``_REFRESH_MAX_EVENTS`` matching events into a small stats dict.

    Schema (kept narrow on purpose):

      * ``events_seen``: int
      * ``kind_counts``: ``{kind: count}``
      * ``files_written``: ordered list (max ``_REFRESH_MAX_FILES``)
      * ``bash_commands_total`` / ``web_fetches_total`` /
        ``errors_total`` / ``duration_ms_total`` / ``cost_usd_total``

    Mirrors the shape used by ``memory_distill`` — when the user
    later runs that tool with ``update_note=True``, the body shape
    is congruent.
    """
    stm = getattr(memory_manager, "short_term", None)
    if stm is None:
        return None
    try:
        entries = list(stm.load_all() or [])
    except Exception:
        logger.debug(
            "entity_bootstrap: STM load_all failed", exc_info=True,
        )
        return None

    kept: List[Tuple[Any, Dict[str, Any]]] = []
    for entry in reversed(entries):
        meta = getattr(entry, "metadata", None)
        if not isinstance(meta, dict) or not meta.get("event_id"):
            continue
        if meta.get("counterpart_id") != counterpart_id:
            continue
        kept.append((entry, meta))
        if len(kept) >= _REFRESH_MAX_EVENTS:
            break

    if not kept:
        return None

    kind_counts: Dict[str, int] = {}
    files_written: List[str] = []
    files_seen: set = set()
    bash_total = 0
    web_total = 0
    error_total = 0
    duration_total = 0
    cost_total = 0.0
    cost_observed = False

    for _entry, meta in kept:
        kind = meta.get("kind") or "unknown"
        kind_counts[kind] = kind_counts.get(kind, 0) + 1
        payload = meta.get("payload") if isinstance(meta.get("payload"), dict) else {}
        for f in payload.get("files_written", []) or []:
            if f and f not in files_seen:
                files_seen.add(f)
                files_written.append(f)
        bash_total += len(payload.get("bash_commands") or [])
        web_total += len(payload.get("web_fetches") or [])
        error_total += len(payload.get("errors") or [])
        duration_total += int(payload.get("duration_ms") or 0)
        c = payload.get("cost_usd")
        if isinstance(c, (int, float)):
            cost_total += float(c)
            cost_observed = True

    return {
        "counterpart_id": counterpart_id,
        "events_seen": len(kept),
        "kind_counts": kind_counts,
        "files_written": files_written[:_REFRESH_MAX_FILES],
        "bash_commands_total": bash_total,
        "web_fetches_total": web_total,
        "errors_total": error_total,
        "duration_ms_total": duration_total,
        "cost_usd_total": cost_total if cost_observed else None,
    }


def _render_entity_stats_body(
    stats: Dict[str, Any], counterpart_role: Optional[str],
) -> str:
    """Render the markdown body for an entity refresh.

    Self-contained (no dependency on ``memory_inspect_tools``) —
    keeps the entity_bootstrap module free of heavy imports
    (BaseTool / ToolCapabilities) on the recorder's hot path.
    """
    lines: List[str] = []
    lines.append(f"# Counterpart: {stats['counterpart_id']}")
    lines.append("")
    lines.append("_(자동 갱신 — `memory_distill(narrative=true)` 으로 LLM 요약을 추가할 수 있어요.)_")
    lines.append("")
    lines.append("## Stats")
    lines.append("")
    lines.append(f"- Events observed: **{stats['events_seen']}**")
    if counterpart_role:
        lines.append(f"- Role: `{counterpart_role}`")
    if stats["kind_counts"]:
        kc = ", ".join(
            f"{k}={v}" for k, v in sorted(stats["kind_counts"].items())
        )
        lines.append(f"- Kinds: {kc}")
    if stats["files_written"]:
        lines.append(f"- Files written: {len(stats['files_written'])}")
        for f in stats["files_written"]:
            lines.append(f"    - `{f}`")
    if stats["bash_commands_total"]:
        lines.append(f"- Bash commands: {stats['bash_commands_total']}")
    if stats["web_fetches_total"]:
        lines.append(f"- Web fetches: {stats['web_fetches_total']}")
    if stats["errors_total"]:
        lines.append(f"- Errors: {stats['errors_total']}")
    if stats["duration_ms_total"]:
        lines.append(f"- Total duration: {stats['duration_ms_total']/1000:.1f}s")
    if stats["cost_usd_total"] is not None:
        lines.append(f"- Total cost: ${stats['cost_usd_total']:.4f}")
    lines.append("")
    return "\n".join(lines)
