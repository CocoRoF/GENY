"""
Long-term memory — file-based Markdown store.

Inspired by OpenClaw's MEMORY.md + memory/*.md pattern.

Layout inside *storage_path*::

    <storage_path>/
        memory/
            MEMORY.md           ← evergreen knowledge
            2026-02-19.md       ← dated journal entries (auto-named)
            topics/
                architecture.md ← optional sub-topics

Long-term memory is durable across session restarts.
The agent writes to it explicitly (via a tool or flush), and
reads are done through keyword search over the markdown files.
"""

from __future__ import annotations

import os
import re
import unicodedata
from datetime import datetime, timezone, timedelta
from logging import getLogger
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from service.memory.types import MemoryEntry, MemorySearchResult, MemorySource

logger = getLogger(__name__)

# Use configured timezone from GENY_TIMEZONE env var
from service.utils.utils import _configured_tz as _get_tz

# Maximum file size we will index (256 KB).
MAX_FILE_SIZE = 256_000

# Only markdown files are indexed.
_MD_PATTERN = re.compile(r"\.md$", re.IGNORECASE)

# Dated filename pattern for temporal scoring.
_DATE_RE = re.compile(r"(\d{4}-\d{2}-\d{2})")

# YAML frontmatter delimiter at file start.
_FRONTMATTER_RE = re.compile(r"^---\s*\n.*?\n---\s*\n", re.DOTALL)


def _strip_frontmatter(raw: str) -> str:
    """Drop the YAML frontmatter block from a markdown file.

    Used by ``LongTermMemory.load_pinned`` so the system prompt
    receives only the human-readable body — the frontmatter is
    structural metadata the LLM does not need to see.
    """
    if not raw:
        return ""
    return _FRONTMATTER_RE.sub("", raw, count=1).strip()


# ── Search-time text normalisation (Memory v2 PR 12) ─────────────────

# Common English stopwords that drown the keyword density signal in
# multilingual queries (a Korean+English mixed query usually carries
# the meaning in the non-English tokens).
_EN_STOPWORDS = frozenset({
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "to",
    "of", "in", "on", "at", "for", "and", "or", "but", "if", "with",
    "do", "does", "did", "have", "has", "had", "i", "you", "he", "she",
    "it", "we", "they", "this", "that", "these", "those", "as", "by",
    "from", "into", "about", "what", "which", "who", "whom", "how",
    "why", "when", "where", "so", "not", "no", "yes",
})

# Korean syllable range. Used to detect Hangul tokens; tokens that
# include any Hangul are kept whole even at single-character length
# because Korean words are denser per character than Latin words.
_HANGUL_RE = re.compile(r"[가-힣]")

# Token splitter — Unicode word characters (any script). NFC
# normalisation flattens the precomposed/decomposed Hangul forms so
# the same syllable always compares equal.
_TOKEN_RE = re.compile(r"[\w]+", re.UNICODE)


def _normalise_for_search(text: str) -> str:
    """Return a search-friendly form of ``text``.

    NFC-normalise so precomposed and decomposed Hangul match,
    casefold so Latin scripts are case-insensitive, and collapse
    whitespace.
    """
    if not text:
        return ""
    return unicodedata.normalize("NFC", text).casefold()


def _extract_keywords(query: str) -> List[str]:
    """Tokenise ``query`` for keyword search.

    Rules:
      * NFC-normalise + casefold first.
      * Split on Unicode word boundaries.
      * Drop English stopwords and pure-numeric tokens shorter
        than 2 chars.
      * Keep tokens containing Hangul regardless of length —
        a single Hangul character is already a meaningful unit.
      * Keep Latin tokens with length ≥ 2.
      * For Hangul tokens longer than 2 syllables, also expose
        2- and 3-syllable prefixes so attached postpositions
        ("주인님이라고" → "주인님") still match a body that only
        has the bare noun.
    """
    if not query:
        return []
    norm = _normalise_for_search(query)
    keywords: List[str] = []
    seen: set[str] = set()

    def _push(tok: str) -> None:
        if not tok or tok in seen:
            return
        seen.add(tok)
        keywords.append(tok)

    for tok in _TOKEN_RE.findall(norm):
        if not tok:
            continue
        if tok in _EN_STOPWORDS:
            continue
        has_hangul = bool(_HANGUL_RE.search(tok))
        if not has_hangul and len(tok) < 2:
            continue
        _push(tok)
        # Hangul prefix expansion. Korean noun + postposition is the
        # common case ("주인님이라고", "사용자가", "프로젝트에서");
        # the on-disk body usually carries just the noun, so we
        # additionally try the 2- and 3-syllable prefix. Latin
        # tokens are unaffected.
        if has_hangul and len(tok) > 3:
            _push(tok[:3])
            _push(tok[:2])
        elif has_hangul and len(tok) == 3:
            _push(tok[:2])
    return keywords


class LongTermMemory:
    """File-backed long-term memory inside the session storage directory.

    Usage::

        ltm = LongTermMemory("/tmp/sessions/abc123")
        ltm.ensure_directory()

        # Write
        ltm.append("Decided to use PostgreSQL for persistence.")
        ltm.write_dated("Completed Phase 1 migration.")

        # Read / Search
        results = ltm.search("PostgreSQL")
        entries = ltm.load_all()
    """

    MEMORY_DIR = "memory"
    MAIN_FILE = "MEMORY.md"

    def __init__(self, storage_path: str):
        """
        Args:
            storage_path: The session's root storage directory.
        """
        self._storage_path = Path(storage_path)
        self._memory_dir = self._storage_path / self.MEMORY_DIR
        self._main_file = self._memory_dir / self.MAIN_FILE

        # DB support (set via set_database)
        self._db_manager = None
        self._session_id: Optional[str] = None

    def set_database(self, db_manager, session_id: str) -> None:
        """Enable DB-backed persistence for this memory store.

        Args:
            db_manager: AppDatabaseManager instance.
            session_id: Session ID for DB queries.
        """
        self._db_manager = db_manager
        self._session_id = session_id
        logger.debug("LongTermMemory: DB backend enabled for session %s", session_id)

    @property
    def _db_available(self) -> bool:
        """True if DB is configured and the session ID is set."""
        return self._db_manager is not None and self._session_id is not None

    @property
    def memory_dir(self) -> Path:
        return self._memory_dir

    @property
    def main_file(self) -> Path:
        return self._main_file

    # ------------------------------------------------------------------
    # Directory management
    # ------------------------------------------------------------------

    def ensure_directory(self) -> None:
        """Create the memory/ directory tree if absent."""
        self._memory_dir.mkdir(parents=True, exist_ok=True)

    def exists(self) -> bool:
        """True if the memory directory has any .md files."""
        if not self._memory_dir.exists():
            return False
        return any(self._memory_dir.rglob("*.md"))

    # ------------------------------------------------------------------
    # Write operations
    # ------------------------------------------------------------------

    def append(self, text: str, *, heading: Optional[str] = None) -> None:
        """Append text to the main MEMORY.md file.

        Args:
            text: Content to append.
            heading: Optional markdown heading to prepend.
        """
        self.ensure_directory()
        now = datetime.now(_get_tz())

        lines: list[str] = []
        if heading:
            lines.append(f"\n## {heading}\n")
        lines.append(f"<!-- {now.strftime('%Y-%m-%d %H:%M %Z')} -->\n")
        lines.append(text.rstrip() + "\n")

        with open(self._main_file, "a", encoding="utf-8") as f:
            f.write("\n".join(lines))

        logger.debug(
            "LongTermMemory.append: wrote %d chars to %s",
            len(text), self._main_file,
        )

        # Dual-write to DB
        if self._db_available:
            try:
                from service.database.memory_db_helper import db_ltm_append
                db_ltm_append(
                    self._db_manager,
                    self._session_id,
                    content=text,
                    filename=str(self._main_file.relative_to(self._storage_path)),
                    heading=heading or "",
                )
            except Exception as e:
                logger.debug("LongTermMemory: DB append failed (non-critical): %s", e)

    def write_dated(self, text: str, *, date: Optional[datetime] = None) -> Path:
        """Write text to a dated file (memory/YYYY-MM-DD.md).

        If the file already exists, content is appended.

        Args:
            text: Content to write.
            date: Date to use for the filename (default: now KST).

        Returns:
            Path to the written file.
        """
        self.ensure_directory()
        date = date or datetime.now(_get_tz())
        filename = f"{date.strftime('%Y-%m-%d')}.md"
        filepath = self._memory_dir / filename

        now_str = date.strftime("%H:%M %Z")
        with open(filepath, "a", encoding="utf-8") as f:
            f.write(f"\n---\n_({now_str})_\n\n{text.rstrip()}\n")

        logger.debug(
            "LongTermMemory.write_dated: wrote %d chars to %s",
            len(text), filepath,
        )

        # Dual-write to DB
        if self._db_available:
            try:
                from service.database.memory_db_helper import db_ltm_write_dated
                db_ltm_write_dated(
                    self._db_manager,
                    self._session_id,
                    content=text,
                    date_str=date.strftime("%Y-%m-%d"),
                )
            except Exception as e:
                logger.debug("LongTermMemory: DB write_dated failed (non-critical): %s", e)

        return filepath

    def write_topic(self, topic: str, text: str) -> Path:
        """Write text to a topic file (memory/topics/<topic>.md).

        Args:
            topic: Topic slug (will be slugified).
            text: Content to write.

        Returns:
            Path to the written file.
        """
        self.ensure_directory()
        topics_dir = self._memory_dir / "topics"
        topics_dir.mkdir(exist_ok=True)

        slug = re.sub(r"[^a-z0-9_-]", "_", topic.lower().strip())[:64]
        filepath = topics_dir / f"{slug}.md"

        now = datetime.now(_get_tz())
        with open(filepath, "a", encoding="utf-8") as f:
            f.write(
                f"\n---\n_({now.strftime('%Y-%m-%d %H:%M %Z')})_\n\n"
                f"{text.rstrip()}\n"
            )

        logger.debug("LongTermMemory.write_topic: %s → %s", topic, filepath)

        # Dual-write to DB
        if self._db_available:
            try:
                from service.database.memory_db_helper import db_ltm_write_topic
                db_ltm_write_topic(
                    self._db_manager,
                    self._session_id,
                    topic=topic,
                    content=text,
                )
            except Exception as e:
                logger.debug("LongTermMemory: DB write_topic failed (non-critical): %s", e)

        return filepath

    # ------------------------------------------------------------------
    # Read operations
    # ------------------------------------------------------------------

    def load_all(self) -> List[MemoryEntry]:
        """Load all markdown files as MemoryEntry objects.

        Tries DB first, falls back to file-system scan.

        Returns entries sorted by: MEMORY.md first, then dated files
        newest-first, then alphabetical.
        """
        # Try DB first
        if self._db_available:
            db_entries = self._load_all_from_db()
            if db_entries is not None:
                return db_entries

        # Fallback to file-system
        if not self._memory_dir.exists():
            return []

        files = self._list_md_files()
        entries: list[MemoryEntry] = []

        for filepath in files:
            try:
                stat = filepath.stat()
                if stat.st_size > MAX_FILE_SIZE or stat.st_size == 0:
                    continue
                content = filepath.read_text(encoding="utf-8").strip()
                if not content:
                    continue

                rel = str(filepath.relative_to(self._storage_path))
                mtime = datetime.fromtimestamp(stat.st_mtime, tz=_get_tz())

                entries.append(MemoryEntry(
                    source=MemorySource.LONG_TERM,
                    content=content,
                    timestamp=mtime,
                    filename=rel,
                    metadata={"size": stat.st_size},
                ))
            except (OSError, UnicodeDecodeError) as exc:
                logger.warning("LongTermMemory: skip %s: %s", filepath, exc)

        return entries

    def _load_all_from_db(self) -> Optional[List[MemoryEntry]]:
        """Load all LTM entries from DB. Returns None if unavailable."""
        try:
            from service.database.memory_db_helper import db_ltm_load_all
            rows = db_ltm_load_all(self._db_manager, self._session_id)
            if rows is None:
                return None

            entries: list[MemoryEntry] = []
            for row in rows:
                content = row.get("content", "")
                filename = row.get("filename", "")
                ts_str = row.get("entry_timestamp", "")
                timestamp = None
                if ts_str:
                    try:
                        timestamp = datetime.fromisoformat(ts_str)
                    except (ValueError, TypeError):
                        pass

                entries.append(MemoryEntry(
                    source=MemorySource.LONG_TERM,
                    content=content,
                    timestamp=timestamp,
                    filename=filename,
                    metadata={
                        "entry_type": row.get("entry_type", "text"),
                        "heading": row.get("heading", ""),
                        "topic": row.get("topic", ""),
                    },
                ))
            return entries
        except Exception as e:
            logger.debug("LongTermMemory: DB load_all failed, falling back to file: %s", e)
            return None

    def load_main(self) -> Optional[MemoryEntry]:
        """Load only the main MEMORY.md file."""
        if not self._main_file.exists():
            return None
        try:
            content = self._main_file.read_text(encoding="utf-8").strip()
            if not content:
                return None
            return MemoryEntry(
                source=MemorySource.LONG_TERM,
                content=content,
                filename=str(self._main_file.relative_to(self._storage_path)),
                timestamp=datetime.fromtimestamp(
                    self._main_file.stat().st_mtime, tz=_get_tz()
                ),
            )
        except (OSError, UnicodeDecodeError) as exc:
            logger.warning("LongTermMemory.load_main: %s", exc)
            return None

    # ------------------------------------------------------------------
    # Pinned facts (Memory v2 PR 12 / T1 tier)
    # ------------------------------------------------------------------

    # Subdirectory that holds always-inject facts. Mirrors the
    # ``PINNED_CATEGORY`` constant in ``structured_writer.py`` so the
    # writer and the loader agree on the on-disk location.
    PINNED_DIR = "critical"

    def load_pinned(self, *, max_chars: int = 3000) -> Optional[MemoryEntry]:
        """Return the concatenated pinned-facts surface.

        Reads everything under ``memory/critical/*.md`` (Memory v2
        T1 tier) and the body of ``MEMORY.md`` if non-empty, packs
        it into a single ``MemoryEntry`` capped at ``max_chars``,
        and returns it. The retriever's
        ``GenyMemoryRetriever._load_pinned_facts`` calls this via
        duck-typing on every turn so the resulting block lands in
        the system prompt under ``# Pinned Facts``.

        Returns ``None`` when there is nothing pinned (no
        critical/*.md files and no MEMORY.md content). The retriever
        treats ``None`` as a no-op so dormant sessions stay clean.

        The function is intentionally tolerant of corrupt /
        partially-readable files — unreadable ones are skipped with
        a debug log so a single broken file never wedges the whole
        pinned surface.
        """
        max_chars = max(0, int(max_chars))
        if max_chars <= 0:
            return None

        parts: List[str] = []
        total = 0

        # 1) MEMORY.md first — this is the host's "evergreen" surface
        #    and many users curate it manually.
        try:
            main_entry = self.load_main()
        except Exception:  # pragma: no cover — load_main is robust already
            main_entry = None
        if main_entry and main_entry.content:
            body = main_entry.content.strip()
            if body:
                header = f"## MEMORY.md\n\n{body}"
                if total + len(header) <= max_chars:
                    parts.append(header)
                    total += len(header)

        # 2) memory/critical/*.md — the auto-promoted + manually-pinned
        #    facts. Sorted by mtime descending so the freshest pinned
        #    facts land first when the budget caps the output.
        pinned_dir = self._memory_dir / self.PINNED_DIR
        if pinned_dir.exists() and pinned_dir.is_dir():
            try:
                files = [
                    p for p in pinned_dir.iterdir()
                    if p.is_file()
                    and p.suffix.lower() == ".md"
                    and p.stat().st_size <= MAX_FILE_SIZE
                ]
            except OSError as exc:
                logger.debug("LongTermMemory.load_pinned: iterdir failed: %s", exc)
                files = []
            files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
            for path in files:
                if total >= max_chars:
                    break
                try:
                    raw = path.read_text(encoding="utf-8").strip()
                except (OSError, UnicodeDecodeError) as exc:
                    logger.debug(
                        "LongTermMemory.load_pinned: skipped %s (%s)", path, exc,
                    )
                    continue
                if not raw:
                    continue
                # Strip YAML frontmatter — it's noise inside the
                # system prompt. The retriever wants the human-
                # readable body only.
                body = _strip_frontmatter(raw)
                if not body:
                    continue
                title = path.stem
                section = f"## {title}\n\n{body}"
                # Hard-cut a single section so one giant pinned file
                # cannot starve the rest.
                remaining = max_chars - total
                if len(section) > remaining:
                    section = section[: max(0, remaining - 1)].rstrip() + "…"
                parts.append(section)
                total += len(section) + 2  # +2 for the joiner blank line

        if not parts:
            return None

        joined = "\n\n".join(parts)
        return MemoryEntry(
            source=MemorySource.LONG_TERM,
            content=joined,
            filename=f"{self.PINNED_DIR}/*",
            timestamp=datetime.now(_get_tz()),
            metadata={"layer": "pinned", "char_count": len(joined)},
        )

    def search(
        self,
        query: str,
        *,
        max_results: int = 5,
    ) -> List[MemorySearchResult]:
        """Simple keyword search over all long-term memory files.

        Tries DB first, falls back to file-based search.
        Scores are based on keyword hit density + recency bonus.

        Args:
            query: Search query string.
            max_results: Maximum results to return.
        """
        if not query.strip():
            return []

        # Try DB first
        if self._db_available:
            try:
                from service.database.memory_db_helper import db_ltm_search
                db_rows = db_ltm_search(
                    self._db_manager, self._session_id,
                    query_text=query, max_results=max_results,
                )
                if db_rows is not None and len(db_rows) > 0:
                    results: list[MemorySearchResult] = []
                    for row in db_rows:
                        content = row.get("content", "")
                        ts_str = row.get("entry_timestamp", "")
                        timestamp = None
                        if ts_str:
                            try:
                                timestamp = datetime.fromisoformat(ts_str)
                            except (ValueError, TypeError):
                                pass

                        entry = MemoryEntry(
                            source=MemorySource.LONG_TERM,
                            content=content,
                            timestamp=timestamp,
                            filename=row.get("filename", ""),
                            metadata={
                                "entry_type": row.get("entry_type", "text"),
                                "heading": row.get("heading", ""),
                                "topic": row.get("topic", ""),
                            },
                        )
                        snippet = self._extract_snippet(content, query.split()[0]) if query.split() else content[:240]
                        results.append(MemorySearchResult(
                            entry=entry,
                            score=1.0,
                            snippet=snippet,
                            match_type="db_keyword",
                        ))
                    return results
            except Exception as e:
                logger.debug("LongTermMemory: DB search failed: %s", e)

        # Fallback to file-based search
        entries = self.load_all()
        # Memory v2 PR 12 — multilingual-aware tokenisation. NFC +
        # casefold + Hangul-friendly splitting so Korean queries
        # match Korean substrings inside English-titled notes (and
        # vice-versa) instead of failing on naive ``str.split()``.
        keywords = _extract_keywords(query)

        if not keywords:
            return []

        results: list[MemorySearchResult] = []
        now = datetime.now(_get_tz())

        for entry in entries:
            content_norm = _normalise_for_search(entry.content)
            # Keyword density score
            hits = sum(
                content_norm.count(kw) for kw in keywords
            )
            if hits == 0:
                continue

            density = hits / max(1, len(entry.content.split()))

            # Recency bonus (exponential decay, half-life 30 days)
            recency = 0.0
            if entry.timestamp:
                age_days = (now - entry.timestamp).total_seconds() / 86400
                recency = 2 ** (-age_days / 30.0)

                # Evergreen bonus: MEMORY.md gets no decay
                if entry.filename and self.MAIN_FILE in entry.filename:
                    recency = 1.0

            score = (density * 0.7) + (recency * 0.3)

            # Build snippet around first hit
            snippet = self._extract_snippet(entry.content, keywords[0])

            results.append(MemorySearchResult(
                entry=entry,
                score=score,
                snippet=snippet,
                match_type="combined",
            ))

        results.sort(key=lambda r: r.score, reverse=True)
        return results[:max_results]

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _list_md_files(self) -> List[Path]:
        """List .md files in priority order."""
        if not self._memory_dir.exists():
            return []

        all_files = [
            f for f in self._memory_dir.rglob("*.md")
            if f.is_file() and f.stat().st_size <= MAX_FILE_SIZE
        ]

        def sort_key(p: Path) -> tuple:
            # MEMORY.md first (priority 0)
            if p.name == self.MAIN_FILE:
                return (0, "")
            # Dated files next (priority 1), newest first (negative ordinal)
            m = _DATE_RE.search(p.stem)
            if m:
                try:
                    return (1, -int(m.group(1).replace("-", "")))
                except ValueError:
                    pass
            # Others last
            return (2, p.name)

        all_files.sort(key=sort_key)
        return all_files

    @staticmethod
    def _extract_snippet(text: str, keyword: str, context: int = 120) -> str:
        """Extract a snippet centered on the first keyword occurrence."""
        idx = text.lower().find(keyword.lower())
        if idx < 0:
            return text[:context * 2]
        start = max(0, idx - context)
        end = min(len(text), idx + len(keyword) + context)
        snippet = text[start:end]
        if start > 0:
            snippet = "..." + snippet
        if end < len(text):
            snippet = snippet + "..."
        return snippet
