"""Compaction archiver — Memory v2 PR 8.

When the ``s02 ContextStage`` compactor (LLMSummaryCompactor in PR 7,
or the placeholder it falls back to) runs, the executor emits a
``context.compacted`` event but does **not** persist the resulting
summary anywhere durable. Plan §2.2 calls this out as the central
gap for compaction's value: a summary that disappears with the
process can't help the *next* session.

This module persists every compaction in two places:

  * ``transcripts/compactions/<ts>.md`` — audit log next to STM.
  * ``memory/compactions/<sid>__<ts>.md`` — vault-searchable note
    so ``memory_search(category="compactions")`` and the Opsidian
    Notes view both surface it.

The two writes share a single render so a future operator who
diffs the audit copy against the vault copy gets byte-equal text.

The frontmatter is intentionally minimal — compactions are
``Artifact`` notes (plan §1.5 carrying matrix), not user-edited
content. ``importance`` is medium and ``tags`` carry both
``compaction`` and ``system-artifact`` so the search default
ranking surfaces them when relevant but keeps them below
``insights/`` and ``topics/``.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import datetime, tzinfo
from pathlib import Path
from typing import Any, Dict, Optional

from service.memory.frontmatter import render_frontmatter
from service.utils.utils import _configured_tz as _get_tz

logger = logging.getLogger(__name__)


CATEGORY = "compactions"

# Filename component sanitiser — same shape as conversation
# archiver's eid filter; keeps the timestamp / session-id legal on
# all filesystems including Windows.
_FILENAME_SAFE = re.compile(r"[^A-Za-z0-9_\-]")


@dataclass(frozen=True)
class ArchivedCompaction:
    audit_path: str       # transcripts/compactions/<ts>.md
    vault_path: str       # memory/compactions/<sid>__<ts>.md
    relative_vault: str   # "compactions/<sid>__<ts>.md"


class CompactionArchiver:
    """Writer for the two-location compaction snapshot."""

    CATEGORY = CATEGORY

    def __init__(
        self,
        storage_path: str,
        *,
        session_id: str = "",
        tz: Optional[tzinfo] = None,
        memory_provider=None,
    ) -> None:
        self._storage_path = Path(storage_path)
        self._memory_dir = self._storage_path / "memory"
        self._transcripts_dir = self._storage_path / "transcripts"
        self._session_id = session_id
        self._tz = tz or _get_tz()
        self._provider = memory_provider
        import threading
        self._lock = threading.RLock()

    def set_memory_provider(self, provider) -> None:
        """Plug the executor `MemoryProvider` post-construction.

        The vault write (`memory/compactions/<sid>__<ts>.md`) routes
        through `provider.notes().write` when this is set; the audit
        copy at `transcripts/compactions/<ts>.md` keeps its direct
        disk write because that path lives outside the executor's
        notes namespace.
        """
        self._provider = provider

    def archive(
        self,
        summary: str,
        *,
        replaced_count: int,
        ts: Optional[datetime] = None,
        strategy: str = "",
        saved_tokens: Optional[int] = None,
    ) -> Optional[ArchivedCompaction]:
        """Persist one compaction event.

        Best-effort — write failures log at debug and return ``None``
        rather than blocking the pipeline.
        """
        if ts is None:
            ts = datetime.now(self._tz)
        try:
            with self._lock:
                return self._archive_locked(
                    summary, ts, replaced_count, strategy, saved_tokens,
                )
        except Exception:
            logger.debug(
                "compaction_archiver: archive failed — non-critical",
                exc_info=True,
            )
            return None

    # ── internal ─────────────────────────────────────────────────

    def _archive_locked(
        self,
        summary: str,
        ts: datetime,
        replaced_count: int,
        strategy: str,
        saved_tokens: Optional[int],
    ) -> Optional[ArchivedCompaction]:
        ts_slug = self._format_ts(ts)
        sid_safe = self._sanitize(self._session_id) or "session"
        vault_filename = f"{sid_safe}__{ts_slug}.md"
        rel_vault = f"{CATEGORY}/{vault_filename}"
        vault_abs = self._memory_dir / rel_vault
        audit_abs = self._transcripts_dir / "compactions" / f"{ts_slug}.md"

        frontmatter: Dict[str, Any] = {
            "title": f"Compaction · {ts.isoformat()}",
            "category": CATEGORY,
            "ts": ts.isoformat(),
            "session_id": self._session_id,
            "replaced_count": int(replaced_count),
            "strategy": strategy or "",
            "saved_tokens": int(saved_tokens) if saved_tokens is not None else 0,
            "tags": ["compaction", "system-artifact"],
            "importance": "medium",
            "links_to": [],
            "linked_from": [],
        }
        body_lines = [
            f"# Compaction snapshot · {ts.strftime('%Y-%m-%d %H:%M:%S')}",
            "",
            f"- Replaced messages: **{replaced_count}**",
        ]
        if strategy:
            body_lines.append(f"- Strategy: `{strategy}`")
        if saved_tokens:
            body_lines.append(f"- Saved tokens: ~{saved_tokens}")
        body_lines.extend([
            "",
            "## Summary",
            "",
            summary.rstrip("\n"),
            "",
        ])
        body = "\n".join(body_lines)
        full_text = render_frontmatter(frontmatter, body)

        # Vault copy: route through `NotesHandle.write`. The
        # executor owns disk layout + frontmatter rendering; the
        # `full_text` we render above is reused for the audit copy.
        if self._provider is None:
            logger.warning(
                "compaction_archiver: no MemoryProvider attached; "
                "skipping vault write for %s", rel_vault,
            )
            return None
        try:
            from geny_executor.memory.provider import (
                Importance as _Importance,
                NoteDraft,
                Scope,
            )
            from service.memory.sync_async_bridge import run_coro_sync

            draft = NoteDraft(
                title=frontmatter["title"],
                body=body,
                category=CATEGORY,
                tags=list(frontmatter.get("tags") or []),
                importance=_Importance.MEDIUM,
                scope=Scope.SESSION,
                filename=vault_filename,
                frontmatter={
                    "ts": frontmatter["ts"],
                    "session_id": frontmatter["session_id"],
                    "replaced_count": frontmatter["replaced_count"],
                    "strategy": frontmatter["strategy"],
                    "saved_tokens": frontmatter["saved_tokens"],
                    "links_to": frontmatter.get("links_to", []),
                    "linked_from": frontmatter.get("linked_from", []),
                },
            )
            run_coro_sync(self._provider.notes().write(draft))
        except Exception:  # noqa: BLE001
            logger.warning(
                "compaction_archiver: provider write failed for %s",
                vault_abs, exc_info=True,
            )
            return None
        try:
            audit_abs.parent.mkdir(parents=True, exist_ok=True)
            audit_abs.write_text(full_text, encoding="utf-8")
        except OSError as exc:
            # Vault copy succeeded — return that ref even if audit
            # failed, since the vault is the source of truth for
            # search. Log loudly so operators notice.
            logger.warning(
                "compaction_archiver: audit write failed for %s: %s",
                audit_abs, exc,
            )

        return ArchivedCompaction(
            audit_path=str(audit_abs),
            vault_path=str(vault_abs),
            relative_vault=rel_vault,
        )

    @staticmethod
    def _format_ts(ts: datetime) -> str:
        # Filesystem-safe timestamp (avoid colons that Windows
        # blocks). 2026-05-01T01-22-12+0900 — matches conversations/
        # filename time prefix style.
        return ts.strftime("%Y-%m-%dT%H-%M-%S")

    @staticmethod
    def _sanitize(s: str) -> str:
        cleaned = _FILENAME_SAFE.sub("_", s or "")
        return cleaned[:80]


__all__ = ["CATEGORY", "ArchivedCompaction", "CompactionArchiver"]
