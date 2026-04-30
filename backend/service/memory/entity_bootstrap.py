"""Auto-bootstrap of `entities/<counterpart>.md` LTM notes.

Cycle 20260430_3 Stage B — every time the recorder writes an
InteractionEvent that names a *new* counterpart, we drop a tiny
stub note under ``entities/<sanitized>.md``. The existing
MemoryTab tree picks the file up immediately, so users see
"this counterpart's memory bucket" the moment the conversation
exists. distillation later overwrites the body with stats +
optional narrative (cycle 20260430_3 Stage F).

This module is intentionally narrow:

  * idempotent (file exists → skip),
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
from typing import Any, Dict, Optional

from service.memory.interaction_event import parse_event_metadata

logger = logging.getLogger(__name__)


_BOOTSTRAP_BODY = (
    "_(아직 distillation 이 진행되지 않았어요. "
    "`memory_distill` 을 호출하면 누적된 상호작용을 요약해 둡니다.)_\n"
)

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

        # Idempotent — never overwrite an existing entity note.
        ltm = getattr(memory_manager, "_ltm", None)
        memory_dir = (
            getattr(writer, "memory_dir", None)
            or (getattr(ltm, "memory_dir", None) if ltm is not None else None)
        )
        if memory_dir is not None:
            try:
                full = memory_dir / rel_path
                if full.exists():
                    return None
            except Exception:
                # If we can't even stat the file, fall through to write —
                # `write_note(filename_override=...)` will dedupe with
                # `-1.md` suffix in the worst case rather than crashing.
                pass

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
