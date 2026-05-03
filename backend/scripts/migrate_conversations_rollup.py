"""Migrate legacy per-turn conversation files into session rollup files.

Memory v2 PR 13 backfill. Walks every session storage directory and
groups its existing
``memory/conversations/<YYYY-MM-DD>/<HH-MM-SS>__<role>__<eid8>.md``
files (one per turn) into a single
``memory/conversations/<sid_slug>__<title_slug>.md`` rollup file
that the new :class:`ConversationArchiver` writes to natively.

Each legacy file becomes one ``## turn-<eid8>`` block inside the
rollup, ordered by the turn's ``ts`` frontmatter field.

Usage::

    # all sessions under <storage_root>/sessions/
    python -m scripts.migrate_conversations_rollup /var/lib/geny/storage

    # single session directory (for tests / one-off curation)
    python -m scripts.migrate_conversations_rollup --session /var/lib/geny/storage/sessions/abc123

    # dry-run — log what would change without writing
    python -m scripts.migrate_conversations_rollup /var/lib/geny/storage --dry-run

    # delete legacy per-turn files after a successful rollup write.
    # Skipped by default — first run with --keep-legacy to confirm
    # the rollup file looks right, then re-run with --prune.
    python -m scripts.migrate_conversations_rollup /var/lib/geny/storage --prune

Idempotent: re-runs find an existing rollup file, skip turns whose
``## turn-<eid8>`` anchor is already present, and append only the
ones that aren't yet captured. ``--prune`` only removes a legacy
file whose event_id we have already encoded into the rollup.
"""

from __future__ import annotations

import argparse
import logging
import shutil
import sys
import types
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

# Ensure the migration script imports the same archiver helpers the
# runtime uses, so a host upgrade picks up the latest title-slug /
# rendering rules automatically.
HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

# Sidestep the heavy ``service/memory/__init__.py`` (which pulls
# numpy / faiss / httpx for the runtime memory stack we don't need
# here). We register placeholder package modules with ``__path__``
# pointing at the real directories so ``import
# service.memory.conversation_archiver`` resolves the submodule
# directly, skipping the parent ``__init__`` execution. The script
# only needs frontmatter helpers + the archiver module — both of
# which are dependency-light.
def _register_lightweight_package(name: str, path: Path) -> None:
    if name in sys.modules:
        return
    pkg = types.ModuleType(name)
    pkg.__path__ = [str(path)]  # type: ignore[attr-defined]
    sys.modules[name] = pkg


_register_lightweight_package("service", BACKEND / "service")
_register_lightweight_package("service.memory", BACKEND / "service" / "memory")
_register_lightweight_package("service.utils", BACKEND / "service" / "utils")

from service.memory.conversation_archiver import (  # noqa: E402
    CATEGORY,
    _atomic_write,
    _slug_for_session_id,
    _slug_for_title,
    build_links_to,
    build_session_frontmatter,
    build_tags,
    derive_session_title,
    iter_turn_anchors,
    render_turn_block,
    session_filename_for,
    short_event_id,
)
from service.memory.frontmatter import (  # noqa: E402
    parse_frontmatter,
    render_frontmatter,
)
from service.memory.interaction_event import (  # noqa: E402
    Direction,
)

logger = logging.getLogger("migrate_conversations_rollup")


# ── walking helpers ──────────────────────────────────────────────


def _iter_session_dirs(root: Path) -> Iterable[Path]:
    """Yield every session directory (one with ``memory/`` inside)."""
    if (root / "memory").is_dir():
        yield root
        return
    sessions_root = root / "sessions" if (root / "sessions").is_dir() else root
    for child in sorted(sessions_root.iterdir()):
        if child.is_dir() and (child / "memory").is_dir():
            yield child


def _legacy_per_turn_files(memory_dir: Path) -> List[Path]:
    """Return every legacy ``conversations/<date>/*.md`` file.

    The rollup writer puts new files directly under ``conversations/``
    (no date subdir), so anything inside a date subdirectory is
    legacy material to be folded.
    """
    conv_dir = memory_dir / CATEGORY
    if not conv_dir.is_dir():
        return []
    files: List[Path] = []
    for date_dir in conv_dir.iterdir():
        if not date_dir.is_dir():
            continue
        for path in date_dir.iterdir():
            if path.is_file() and path.suffix.lower() == ".md":
                files.append(path)
    files.sort()
    return files


# ── per-turn parsing ─────────────────────────────────────────────


def _coerce_str(value: Any, default: str = "") -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float)):
        return str(value)
    return default


def _coerce_int(value: Any, default: int = 0) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip():
        try:
            return int(value)
        except ValueError:
            return default
    return default


def _parse_legacy_turn(path: Path) -> Optional[Dict[str, Any]]:
    """Parse a legacy per-turn file into the dict the renderer needs.

    Returns ``None`` for files we can't parse (corrupt frontmatter,
    missing required keys). The caller logs and skips.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        logger.warning("read failed: %s (%s)", path, exc)
        return None
    try:
        meta, body = parse_frontmatter(text)
    except Exception:
        logger.warning("frontmatter parse failed: %s", path)
        return None
    meta = meta or {}
    body = body or ""

    event_id = _coerce_str(meta.get("event_id")).strip()
    if not event_id:
        logger.debug("skip %s — no event_id", path)
        return None
    ts_raw = _coerce_str(meta.get("ts")).strip()
    if not ts_raw:
        logger.debug("skip %s — no ts", path)
        return None
    try:
        ts = datetime.fromisoformat(ts_raw)
    except ValueError:
        logger.warning("ts parse failed for %s: %r", path, ts_raw)
        return None

    return {
        "path": path,
        "event_id": event_id,
        "ts": ts,
        "role": _coerce_str(meta.get("role")) or "unknown",
        "kind": _coerce_str(meta.get("kind")) or "user_chat",
        "direction": _coerce_str(meta.get("direction")) or Direction.IN.value,
        "counterpart_id": _coerce_str(meta.get("counterpart")),
        "counterpart_role": _coerce_str(meta.get("counterpart_role")),
        "linked_event_id": _coerce_str(meta.get("linked_event_id")) or None,
        "importance": _coerce_str(meta.get("importance")) or "medium",
        "content_chars": _coerce_int(meta.get("content_chars"), len(body)),
        "session_id": _coerce_str(meta.get("session_id")),
        "body": body,
        "legacy_title": _coerce_str(meta.get("title")),
        "tags": [str(t) for t in (meta.get("tags") or []) if isinstance(t, (str, int, float))],
    }


# ── session grouping ─────────────────────────────────────────────


def _group_by_session(
    turns: List[Dict[str, Any]],
    *,
    fallback_session_id: str,
) -> Dict[str, List[Dict[str, Any]]]:
    """Group turn dicts by ``session_id``. Falls back to
    ``fallback_session_id`` (the directory name) when a turn's
    frontmatter omitted it — this keeps pre-1.10 logs migratable.
    """
    by_sid: Dict[str, List[Dict[str, Any]]] = {}
    for t in turns:
        sid = (t.get("session_id") or "").strip() or fallback_session_id
        by_sid.setdefault(sid, []).append(t)
    for sid in by_sid:
        by_sid[sid].sort(key=lambda d: d["ts"])
    return by_sid


# ── rollup building ──────────────────────────────────────────────


def _build_or_update_rollup(
    *,
    memory_dir: Path,
    session_id: str,
    turns: List[Dict[str, Any]],
    dry_run: bool,
) -> Tuple[Optional[Path], int]:
    """Append ``turns`` into a rollup file. Returns
    ``(rollup_path, appended_count)``. ``appended_count`` is 0 when
    every turn anchor was already present.
    """
    if not turns:
        return None, 0

    sid_slug = _slug_for_session_id(session_id)
    conv_dir = memory_dir / CATEGORY
    existing_path: Optional[Path] = None
    for entry in sorted(conv_dir.glob("*.md")):
        stem = entry.stem
        if stem == sid_slug or stem.startswith(f"{sid_slug}__"):
            existing_path = entry
            break

    if existing_path is not None:
        try:
            existing_text = existing_path.read_text(encoding="utf-8")
        except OSError as exc:
            logger.warning("read failed for existing rollup %s: %s", existing_path, exc)
            return None, 0
        meta, body = parse_frontmatter(existing_text)
        meta = meta or {}
        body = body or ""
        rollup_path = existing_path
    else:
        # Choose a title — first user-facing turn body wins, falling
        # back to the legacy frontmatter title (which the per-turn
        # writer set to ``[kind] body-preview``) when the body itself
        # starts with markdown structure.
        seed = ""
        for t in turns:
            seed = derive_session_title(
                kind=t["kind"], direction=t["direction"], content=t["body"],
            )
            if seed:
                break
        if not seed:
            for t in turns:
                if t.get("legacy_title"):
                    seed = t["legacy_title"]
                    break
        title_slug = _slug_for_title(seed)
        rel = session_filename_for(session_id=session_id, title_slug=title_slug)
        rollup_path = memory_dir / rel
        meta, body = {}, ""

    existing_anchors = {eid for eid, _ in iter_turn_anchors(body)}
    appended = 0
    importance_max = str(meta.get("importance_max") or meta.get("importance") or "low").lower()
    rank = {"low": 0, "medium": 1, "high": 2, "critical": 3}

    event_ids = [str(e) for e in (meta.get("event_ids") or []) if isinstance(e, (str, int, float))]
    kinds = [str(k) for k in (meta.get("kinds") or []) if isinstance(k, str)]
    counterparts = [str(c) for c in (meta.get("counterparts") or []) if isinstance(c, str)]
    tags = [str(t) for t in (meta.get("tags") or []) if isinstance(t, str)]
    links_to = [str(l) for l in (meta.get("links_to") or []) if isinstance(l, str)]
    title = (
        meta.get("title")
        if isinstance(meta.get("title"), str) and meta["title"].strip()
        else None
    )
    date_first = (
        meta.get("date_first")
        if isinstance(meta.get("date_first"), str) and meta["date_first"]
        else None
    )

    for t in turns:
        eid8 = short_event_id(t["event_id"], width=8)
        if eid8 in existing_anchors:
            continue
        ts: datetime = t["ts"]
        date_iso = ts.date().isoformat()
        turn_links = build_links_to(
            kind=t["kind"], counterpart_id=t["counterpart_id"], date=date_iso,
        )
        turn_tags = build_tags(
            kind=t["kind"], counterpart_role=t["counterpart_role"] or None,
        )

        block = render_turn_block(
            eid8=eid8,
            event_id=t["event_id"],
            ts=ts,
            role=t["role"],
            kind=t["kind"],
            direction=t["direction"],
            counterpart_id=t["counterpart_id"] or None,
            counterpart_role=t["counterpart_role"] or None,
            importance=t["importance"],
            content_chars=t["content_chars"],
            linked_event_id=t["linked_event_id"],
            body=t["body"],
        )
        sep = "\n\n---\n\n" if body and body.strip() else ""
        body = (body.rstrip() + sep + block) if body else block
        existing_anchors.add(eid8)
        appended += 1

        if eid8 not in event_ids:
            event_ids.append(eid8)
        if t["kind"] and t["kind"] not in kinds:
            kinds.append(t["kind"])
        cp = (t["counterpart_id"] or "").strip()
        if cp and cp not in {"self", "system", "", "unknown"} and cp not in counterparts:
            counterparts.append(cp)
        for tag in turn_tags:
            if tag not in tags:
                tags.append(tag)
        for link in turn_links:
            if link not in links_to:
                links_to.append(link)
        if rank.get(t["importance"], 0) > rank.get(importance_max, 0):
            importance_max = t["importance"]
        if not date_first or date_iso < date_first:
            date_first = date_iso
        if not title:
            seed = derive_session_title(
                kind=t["kind"], direction=t["direction"], content=t["body"],
            )
            if seed:
                title = seed

    if not appended and existing_path is not None:
        return rollup_path, 0

    if title is None or not title.strip():
        title = f"Session {sid_slug}"
    if importance_max not in rank:
        importance_max = "low"
    date_last = max(t["ts"].date().isoformat() for t in turns)
    if date_first is None:
        date_first = min(t["ts"].date().isoformat() for t in turns)

    new_meta = build_session_frontmatter(
        session_id=session_id,
        title=title,
        date_first=date_first,
        date_last=date_last,
        turn_count=int(meta.get("turn_count") or 0) + appended,
        event_ids=event_ids,
        kinds=kinds,
        counterparts=counterparts,
        importance_max=importance_max,
        tags=tags,
        links_to=links_to,
    )
    rendered = render_frontmatter(new_meta, body)

    if dry_run:
        logger.info(
            "[dry-run] would write %s (%d new turn block%s, %d existing)",
            rollup_path, appended, "s" if appended != 1 else "",
            len(existing_anchors) - appended,
        )
        return rollup_path, appended

    if not _atomic_write(rollup_path, rendered):
        return None, 0
    logger.info("rolled %d turn(s) into %s", appended, rollup_path)
    return rollup_path, appended


# ── pruning legacy ───────────────────────────────────────────────


def _prune_legacy(
    paths: List[Path],
    *,
    dry_run: bool,
    archive_dir: Optional[Path] = None,
) -> int:
    """Remove the legacy per-turn files we just folded.

    When ``archive_dir`` is given, files are moved there instead of
    deleted (safer default for first-time operators); otherwise
    they are unlinked.
    """
    pruned = 0
    for path in paths:
        if dry_run:
            logger.info("[dry-run] would prune %s", path)
            pruned += 1
            continue
        try:
            if archive_dir is not None:
                rel = path.name
                target = archive_dir / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(path), str(target))
            else:
                path.unlink()
            pruned += 1
        except OSError as exc:
            logger.warning("prune failed: %s (%s)", path, exc)
    # Best-effort: drop empty date subdirs left behind.
    if not dry_run:
        for path in paths:
            try:
                parent = path.parent
                if parent.is_dir() and not any(parent.iterdir()):
                    parent.rmdir()
            except OSError:
                pass
    return pruned


# ── orchestration ────────────────────────────────────────────────


def _migrate_session(
    session_dir: Path,
    *,
    dry_run: bool,
    prune: bool,
) -> Tuple[int, int, int]:
    """Migrate one session. Returns (turns_seen, turns_appended, files_pruned)."""
    memory_dir = session_dir / "memory"
    legacy_files = _legacy_per_turn_files(memory_dir)
    if not legacy_files:
        return 0, 0, 0
    parsed: List[Dict[str, Any]] = []
    for path in legacy_files:
        record = _parse_legacy_turn(path)
        if record is not None:
            parsed.append(record)
    if not parsed:
        return len(legacy_files), 0, 0
    by_sid = _group_by_session(parsed, fallback_session_id=session_dir.name)
    total_appended = 0
    for sid, turns in by_sid.items():
        _, appended = _build_or_update_rollup(
            memory_dir=memory_dir,
            session_id=sid,
            turns=turns,
            dry_run=dry_run,
        )
        total_appended += appended
    pruned = 0
    if prune:
        # Only prune files that landed (or were already present) in the rollup.
        # Conservative: prune everything we successfully parsed.
        pruned = _prune_legacy(
            [d["path"] for d in parsed], dry_run=dry_run,
        )
    return len(legacy_files), total_appended, pruned


def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Backfill session-rollup conversation files (Memory v2 PR 13).",
    )
    parser.add_argument(
        "root",
        nargs="?",
        help="Storage root (containing sessions/<id>/memory/) "
             "or a single session directory.",
    )
    parser.add_argument(
        "--session",
        type=Path,
        help="Single session directory (alternative to root).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Log what would change without writing.",
    )
    parser.add_argument(
        "--prune",
        action="store_true",
        help="Delete the legacy per-turn files after a successful rollup write.",
    )
    parser.add_argument(
        "-v", "--verbose",
        action="store_true",
        help="Verbose logging.",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    if args.session is not None:
        targets = [args.session]
    elif args.root:
        root = Path(args.root)
        if not root.is_dir():
            logger.error("not a directory: %s", root)
            return 2
        targets = list(_iter_session_dirs(root))
    else:
        parser.error("either ROOT or --session must be supplied")
        return 2

    if not targets:
        logger.warning("no session directories found")
        return 0

    total_seen = total_appended = total_pruned = 0
    for session_dir in targets:
        try:
            seen, appended, pruned = _migrate_session(
                session_dir, dry_run=args.dry_run, prune=args.prune,
            )
        except Exception as exc:  # pragma: no cover — best-effort batch
            logger.warning("session %s failed: %s", session_dir, exc)
            continue
        total_seen += seen
        total_appended += appended
        total_pruned += pruned
        logger.info(
            "session %s: legacy=%d appended=%d pruned=%d",
            session_dir, seen, appended, pruned,
        )

    logger.info(
        "done: %d sessions, %d legacy files, %d new turn blocks, %d pruned",
        len(targets), total_seen, total_appended, total_pruned,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
