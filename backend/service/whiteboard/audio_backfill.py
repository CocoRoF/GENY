"""
Inbox audio transcript backfill — V1 of the voice-notes follow-up
(``docs/voice-notes/`` after the W1-W4 core landed).

Problem the W2 PostCaptureHook leaves behind:
  * Audio captures that landed *before* W2 deployed have no transcript.
  * Audio captures that landed while ``geny-whisper-stt`` was momentarily
    down ended with ``source="unavailable"`` and never got a retry.

This module is the safety net. A long-running asyncio task scans every
user vault's ``_captures.jsonl``, finds audio captures whose draft note
body is missing the standard ``> **Transcript (lang):** …`` block, and
transcribes them one at a time. The loop yields generously between
runs so it never out-prioritises a live capture upload on the single
GPU vLLM is using.

Public surface:
  * :func:`backfill_one_user` — single-pass scan + best-effort transcribe.
    Returns ``BackfillRunResult``. Used by both the loop and the
    manual ``POST /api/stt/backfill`` endpoint.
  * :func:`audio_backfill_loop` — infinite asyncio loop. Wired up
    in ``main.py`` ``lifespan`` startup.
  * :func:`start_audio_backfill_loop` — convenience starter mirroring
    :func:`start_library_watcher`.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from logging import getLogger
from pathlib import Path
from typing import Iterator, List, Optional, Sequence

logger = getLogger(__name__)


# ── Layout helpers ────────────────────────────────────────────────────


def _user_opsidian_root() -> Path:
    """Return ``{STORAGE_ROOT}/_user_opsidian`` (parent of every
    per-user vault). Resolved on every call so an operator can move
    the storage root between deploys without a backend restart."""
    from service.utils.platform import DEFAULT_STORAGE_ROOT
    return Path(DEFAULT_STORAGE_ROOT) / "_user_opsidian"


def _list_usernames() -> List[str]:
    """Every directory under ``_user_opsidian/`` is one user's vault.

    Hidden / dotfiles are skipped — those are reserved for internal
    bookkeeping (``_index.json`` style sidecars). Returned in
    deterministic alphabetical order so the round-robin order is
    stable across restarts.
    """
    root = _user_opsidian_root()
    if not root.exists():
        return []
    try:
        return sorted(
            entry.name
            for entry in root.iterdir()
            if entry.is_dir() and not entry.name.startswith(".")
        )
    except OSError:
        return []


# ── Audio extension allowlist ─────────────────────────────────────────


_AUDIO_EXT_HINTS = (
    ".webm",
    ".ogg",
    ".oga",
    ".mp3",
    ".wav",
    ".m4a",
    ".mp4",
    ".aac",
    ".flac",
)


def _looks_like_audio(path: str) -> bool:
    lower = (path or "").lower()
    return any(lower.endswith(ext) for ext in _AUDIO_EXT_HINTS)


# ── Transcript-block guard ────────────────────────────────────────────
# The W2 hook prepends ``> **Transcript (lang):** ...`` as the first
# block of the body. We match the same shape so this module and the
# hook are bit-for-bit interchangeable: a note touched by either path
# is "done" from the other's perspective.

_TRANSCRIPT_PREFIX = "> **Transcript ("


def _body_has_transcript(body: str) -> bool:
    if not body:
        return False
    # Allow some leading whitespace / a YAML frontmatter close before
    # the block — be permissive on the leading content.
    return _TRANSCRIPT_PREFIX in body


# ── Capture log iteration ─────────────────────────────────────────────


@dataclass(slots=True)
class _CaptureLogEntry:
    capture_id: str
    draft_note: str
    attachment_path: str


def _iter_audio_captures(
    capture_log_path: Path,
) -> Iterator[_CaptureLogEntry]:
    """Yield every audio capture entry from a ``_captures.jsonl``.

    Best-effort: malformed lines are skipped silently. The log can
    grow large (one line per capture, never trimmed), so we read line
    by line instead of slurping.
    """
    if not capture_log_path.exists():
        return
    try:
        with capture_log_path.open("r", encoding="utf-8") as f:
            for raw in f:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    entry = json.loads(raw)
                except (ValueError, json.JSONDecodeError):
                    continue
                if not isinstance(entry, dict):
                    # Malformed-but-parseable lines (e.g. a bare JSON
                    # string from a manual hand-edit) are skipped.
                    continue
                if entry.get("type") != "audio":
                    continue
                draft = entry.get("draft_note") or ""
                attachment = entry.get("attachment_path") or ""
                capture_id = entry.get("capture_id") or ""
                if not (draft and attachment and capture_id):
                    continue
                if not _looks_like_audio(attachment):
                    continue
                yield _CaptureLogEntry(
                    capture_id=str(capture_id),
                    draft_note=str(draft),
                    attachment_path=str(attachment),
                )
    except OSError as exc:
        logger.debug("audio_backfill: capture log read failed (%s)", exc)


# ── Result types ──────────────────────────────────────────────────────


@dataclass(slots=True)
class BackfillOutcome:
    """One note's outcome — for logs + the manual endpoint's response."""

    username: str
    capture_id: str
    draft_note: str
    status: str  # "filled" | "skipped" | "unavailable" | "missing" | "error"
    language: Optional[str] = None
    text_len: int = 0
    reason: Optional[str] = None


@dataclass(slots=True)
class BackfillRunResult:
    """Summary across one user (or one full scan)."""

    scanned: int = 0
    filled: int = 0
    skipped: int = 0
    unavailable: int = 0
    missing: int = 0
    errors: int = 0
    outcomes: List[BackfillOutcome] = field(default_factory=list)

    def merge(self, other: "BackfillRunResult") -> None:
        self.scanned += other.scanned
        self.filled += other.filled
        self.skipped += other.skipped
        self.unavailable += other.unavailable
        self.missing += other.missing
        self.errors += other.errors
        self.outcomes.extend(other.outcomes)

    def record(self, outcome: BackfillOutcome) -> None:
        self.outcomes.append(outcome)
        if outcome.status == "filled":
            self.filled += 1
        elif outcome.status == "skipped":
            self.skipped += 1
        elif outcome.status == "unavailable":
            self.unavailable += 1
        elif outcome.status == "missing":
            self.missing += 1
        else:
            self.errors += 1

    def to_dict(self) -> dict:
        return {
            "scanned": self.scanned,
            "filled": self.filled,
            "skipped": self.skipped,
            "unavailable": self.unavailable,
            "missing": self.missing,
            "errors": self.errors,
            "outcomes": [
                {
                    "username": o.username,
                    "capture_id": o.capture_id,
                    "draft_note": o.draft_note,
                    "status": o.status,
                    "language": o.language,
                    "text_len": o.text_len,
                    "reason": o.reason,
                }
                for o in self.outcomes
            ],
        }


# ── Per-note backfill ─────────────────────────────────────────────────


async def _backfill_one_note(
    username: str,
    entry: _CaptureLogEntry,
) -> BackfillOutcome:
    """Best-effort: load → check guard → transcribe → prepend.

    Mirrors the W2 ``_transcribe_audio_hook`` body precisely so the
    two paths stay interchangeable. Returns the per-note outcome
    instead of raising.
    """
    try:
        from service.memory.user_opsidian import get_user_opsidian_manager
        from service.stt.whisper_client import get_whisper_client
    except Exception as exc:  # noqa: BLE001
        return BackfillOutcome(
            username=username,
            capture_id=entry.capture_id,
            draft_note=entry.draft_note,
            status="error",
            reason=f"import failed: {exc}",
        )

    mgr = get_user_opsidian_manager(username)
    note = mgr.read_note(entry.draft_note)
    if not note:
        return BackfillOutcome(
            username=username,
            capture_id=entry.capture_id,
            draft_note=entry.draft_note,
            status="missing",
            reason="draft note no longer exists",
        )
    body = str(note.get("body") or "")
    if _body_has_transcript(body):
        return BackfillOutcome(
            username=username,
            capture_id=entry.capture_id,
            draft_note=entry.draft_note,
            status="skipped",
            reason="transcript block already present",
        )

    try:
        audio_bytes = mgr.read_attachment(entry.attachment_path)
    except Exception as exc:  # noqa: BLE001
        return BackfillOutcome(
            username=username,
            capture_id=entry.capture_id,
            draft_note=entry.draft_note,
            status="missing",
            reason=f"read_attachment failed: {exc}",
        )
    if not audio_bytes:
        return BackfillOutcome(
            username=username,
            capture_id=entry.capture_id,
            draft_note=entry.draft_note,
            status="missing",
            reason=f"attachment {entry.attachment_path} unavailable",
        )

    try:
        result = await get_whisper_client().atranscribe(
            audio_bytes,
            filename=entry.attachment_path,
        )
    except Exception as exc:  # noqa: BLE001
        return BackfillOutcome(
            username=username,
            capture_id=entry.capture_id,
            draft_note=entry.draft_note,
            status="error",
            reason=f"atranscribe raised: {exc}",
        )

    if not result.is_ok():
        return BackfillOutcome(
            username=username,
            capture_id=entry.capture_id,
            draft_note=entry.draft_note,
            status="unavailable",
            reason=result.error or f"source={result.source}",
        )

    lang = result.language or "auto"
    block = f"> **Transcript ({lang}):** {result.text.strip()}\n\n"
    if block.strip() in body:
        # Defence-in-depth — the guard above catches the prefix, but
        # an exact block match here also means we shouldn't re-write.
        return BackfillOutcome(
            username=username,
            capture_id=entry.capture_id,
            draft_note=entry.draft_note,
            status="skipped",
            reason="exact transcript block already present",
        )

    try:
        mgr.update_note(entry.draft_note, body=block + body)
    except Exception as exc:  # noqa: BLE001
        return BackfillOutcome(
            username=username,
            capture_id=entry.capture_id,
            draft_note=entry.draft_note,
            status="error",
            reason=f"update_note failed: {exc}",
        )
    return BackfillOutcome(
        username=username,
        capture_id=entry.capture_id,
        draft_note=entry.draft_note,
        status="filled",
        language=lang,
        text_len=len(result.text),
    )


# ── Public scan APIs ──────────────────────────────────────────────────


async def backfill_one_user(
    username: str,
    *,
    max_per_cycle: int = 1,
) -> BackfillRunResult:
    """Walk one user's capture log, transcribe up to *max_per_cycle*
    audio notes that are still missing transcripts.

    The scan is incremental — once we hit *max_per_cycle* fills (or
    *errors* in the unavailable / error sense) we stop. The next call
    picks up where we left off because the guard re-checks the body
    each time. Notes already filled or genuinely empty are cheap to
    skip on a re-scan.
    """
    result = BackfillRunResult()
    from service.memory.user_opsidian import get_user_opsidian_manager
    mgr = get_user_opsidian_manager(username)
    log_path = Path(mgr.vault_root) / "_captures.jsonl"
    seen_capture_ids: set[str] = set()

    for entry in _iter_audio_captures(log_path):
        if entry.capture_id in seen_capture_ids:
            continue
        seen_capture_ids.add(entry.capture_id)
        result.scanned += 1

        outcome = await _backfill_one_note(username, entry)
        result.record(outcome)

        # Stop as soon as we've satisfied the cycle budget on
        # *productive* attempts (filled OR genuinely failed against
        # Whisper). Skipped/missing notes don't burn GPU so they
        # don't count against the cap.
        productive = outcome.status in {"filled", "unavailable", "error"}
        if productive and result.filled + result.unavailable + result.errors >= max_per_cycle:
            break

    return result


async def backfill_all_users(
    *,
    max_per_cycle: int = 1,
    usernames: Optional[Sequence[str]] = None,
) -> BackfillRunResult:
    """Round-robin pass across every user vault (or *usernames*
    when explicit).

    Each user is given its own budget of *max_per_cycle* fills before
    we move to the next — that's intentional: a single user with a
    big backlog shouldn't starve the rest of the vaults.
    """
    summary = BackfillRunResult()
    targets = list(usernames) if usernames is not None else _list_usernames()
    for username in targets:
        per_user = await backfill_one_user(
            username, max_per_cycle=max_per_cycle
        )
        summary.merge(per_user)
    return summary


# ── Loop ──────────────────────────────────────────────────────────────


def _load_config():
    """Return the live :class:`AudioBackfillConfig`. Falls back to
    defaults if the config manager is unavailable (e.g. during early
    boot before the lifespan event has wired it up)."""
    try:
        from service.config import get_config_manager
        from service.config.sub_config.stt.audio_backfill_config import (
            AudioBackfillConfig,
        )
        return get_config_manager().load_config(AudioBackfillConfig)
    except Exception:  # noqa: BLE001
        from service.config.sub_config.stt.audio_backfill_config import (
            AudioBackfillConfig,
        )
        return AudioBackfillConfig()


async def audio_backfill_loop() -> None:
    """Infinite loop — sleeps generously when the vault is fully
    transcribed; runs one (configurable) transcription per cycle
    otherwise. Cancel-friendly: a ``CancelledError`` propagates up
    so the FastAPI shutdown handler can await it cleanly.
    """
    logger.info("[audio-backfill] started")
    try:
        while True:
            cfg = _load_config()
            if not getattr(cfg, "enabled", True):
                # Disabled — long sleep, recheck.
                await asyncio.sleep(float(getattr(cfg, "empty_sleep_seconds", 300.0)))
                continue

            try:
                summary = await backfill_all_users(
                    max_per_cycle=int(getattr(cfg, "max_per_cycle", 1)),
                )
            except Exception:  # noqa: BLE001
                logger.warning(
                    "[audio-backfill] scan threw, sleeping then retrying",
                    exc_info=True,
                )
                await asyncio.sleep(float(getattr(cfg, "empty_sleep_seconds", 300.0)))
                continue

            # `filled + unavailable + errors` are the *productive*
            # cycle outcomes — those that hit Whisper. Skipped /
            # missing notes don't touch the GPU, so they don't tell
            # us anything about how long to sleep.
            if summary.filled + summary.unavailable + summary.errors > 0:
                logger.info(
                    "[audio-backfill] cycle: %d filled, %d unavailable, "
                    "%d errors, %d skipped, %d missing across %d scanned",
                    summary.filled, summary.unavailable, summary.errors,
                    summary.skipped, summary.missing, summary.scanned,
                )
                await asyncio.sleep(float(getattr(cfg, "idle_seconds", 30.0)))
            else:
                # No productive work this pass → sleep longer.
                await asyncio.sleep(
                    float(getattr(cfg, "empty_sleep_seconds", 300.0))
                )
    except asyncio.CancelledError:
        logger.info("[audio-backfill] stopped")
        raise


def start_audio_backfill_loop() -> asyncio.Task:
    """Schedule :func:`audio_backfill_loop` on the running event loop.

    Caller (FastAPI lifespan handler) keeps the returned ``Task`` so
    it can be cancelled on shutdown — mirrors
    :func:`service.vtuber.library_watcher.start_library_watcher`.
    """
    return asyncio.create_task(audio_backfill_loop())
