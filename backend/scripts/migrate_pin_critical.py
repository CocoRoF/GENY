"""Backfill ``memory/critical/`` from existing high-importance insights.

Memory v2 PR 12 — once Geny ships the pinned-facts tier, the
retriever pulls everything under ``memory/critical/`` into every
system prompt. Existing sessions, however, already have insights
saved under ``memory/insights/`` that *should* be pinned but never
were because the auto-pin path didn't exist when they were written.

This script walks every session's ``memory/`` directory, finds notes
whose frontmatter declares ``importance: critical`` or ``high``, and
copies them into ``memory/critical/`` (idempotent — re-runs skip
already-pinned files).

Usage::

    # all sessions under <storage_root>/sessions/
    python -m scripts.migrate_pin_critical /var/lib/geny/storage

    # single session directory (for tests / one-off curation)
    python -m scripts.migrate_pin_critical --session /var/lib/geny/storage/sessions/abc123

    # dry-run — print what would change without writing
    python -m scripts.migrate_pin_critical /var/lib/geny/storage --dry-run

The script is best-effort: a malformed file is logged and skipped
rather than aborting the whole run.
"""

from __future__ import annotations

import argparse
import logging
import re
import shutil
import sys
from pathlib import Path
from typing import Iterable, List, Tuple

logger = logging.getLogger("migrate_pin_critical")

# Eligible importance values we consider "must always be known".
PIN_IMPORTANCE = frozenset({"critical", "high"})

# Subdirectories under memory/ we promote from. ``insights`` is the
# primary source (LLM-distilled facts); ``topics`` and ``projects``
# are also eligible because users sometimes flag them manually.
SOURCE_CATEGORIES = ("insights", "topics", "projects")

# Target subdirectory inside each session's memory/ vault.
PIN_DIR = "critical"

_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
_IMPORTANCE_RE = re.compile(r"^\s*importance\s*:\s*(\S+)", re.MULTILINE)


def _read_importance(path: Path) -> str:
    """Extract the ``importance`` field from a markdown frontmatter.

    Returns ``""`` when no frontmatter or no importance is present.
    """
    try:
        head = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        logger.warning("read failed: %s (%s)", path, exc)
        return ""
    fm = _FRONTMATTER_RE.match(head)
    if not fm:
        return ""
    m = _IMPORTANCE_RE.search(fm.group(1))
    return m.group(1).strip().strip('"').strip("'") if m else ""


def _iter_session_dirs(root: Path) -> Iterable[Path]:
    """Yield each session directory under ``root``.

    A session is recognised by the presence of a ``memory/``
    subdirectory. The function works for both the canonical
    ``<root>/sessions/<id>/`` layout and a single-session root
    passed directly.
    """
    if (root / "memory").is_dir():
        yield root
        return
    sessions_root = root / "sessions" if (root / "sessions").is_dir() else root
    for child in sessions_root.iterdir():
        if child.is_dir() and (child / "memory").is_dir():
            yield child


def _scan_session(memory_dir: Path) -> List[Tuple[Path, str]]:
    """Return ``(path, importance)`` pairs eligible for pinning."""
    found: List[Tuple[Path, str]] = []
    for category in SOURCE_CATEGORIES:
        cat_dir = memory_dir / category
        if not cat_dir.is_dir():
            continue
        for path in cat_dir.iterdir():
            if not path.is_file() or path.suffix.lower() != ".md":
                continue
            importance = _read_importance(path).lower()
            if importance in PIN_IMPORTANCE:
                found.append((path, importance))
    return found


def _backfill_session(
    session_dir: Path,
    *,
    dry_run: bool,
) -> Tuple[int, int]:
    """Backfill one session's ``memory/critical/`` from eligible files.

    Returns ``(copied, skipped)``.
    """
    memory_dir = session_dir / "memory"
    pin_dir = memory_dir / PIN_DIR
    eligible = _scan_session(memory_dir)
    if not eligible:
        return 0, 0

    if not dry_run:
        pin_dir.mkdir(parents=True, exist_ok=True)

    copied = 0
    skipped = 0
    for src, importance in eligible:
        dest_name = f"from-{src.parent.name}-{src.name}"
        dest = pin_dir / dest_name
        if dest.exists():
            skipped += 1
            continue
        if dry_run:
            logger.info("[dry-run] would pin %s (importance=%s) → %s", src, importance, dest)
            copied += 1
            continue
        try:
            shutil.copy2(src, dest)
        except OSError as exc:
            logger.warning("copy failed: %s → %s (%s)", src, dest, exc)
            continue
        copied += 1
        logger.info("pinned %s → %s", src, dest)
    return copied, skipped


def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Backfill memory/critical/ from existing high-importance insights "
            "(Memory v2 PR 12)."
        )
    )
    parser.add_argument(
        "root",
        nargs="?",
        help=(
            "Storage root (containing sessions/<id>/memory/) "
            "or a single session directory. Required unless --session is set."
        ),
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

    total_copied = 0
    total_skipped = 0
    for session_dir in targets:
        try:
            copied, skipped = _backfill_session(session_dir, dry_run=args.dry_run)
        except Exception as exc:  # pragma: no cover — never abort the whole batch
            logger.warning("session %s failed: %s", session_dir, exc)
            continue
        total_copied += copied
        total_skipped += skipped
        logger.info(
            "session %s: copied=%d skipped=%d", session_dir, copied, skipped,
        )

    logger.info(
        "done: %d sessions, %d copied, %d skipped (already pinned)",
        len(targets), total_copied, total_skipped,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
