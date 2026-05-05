"""
Shared data types for the memory subsystem.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional


class MemorySource(str, Enum):
    """Where a memory entry originated."""
    LONG_TERM = "long_term"       # MEMORY.md / memory/*.md files
    SHORT_TERM = "short_term"     # JSONL transcript entries
    BOOTSTRAP = "bootstrap"       # Project context files (AGENTS.md, etc.)


# Valid categories for structured memory notes.
# Memory v2 retired ``entities`` — counterpart info lives in ``dms/``
# now (per-counterpart-per-day index) and stats are derivable from
# ``dms/<cp>/<date>.md`` frontmatter + the StreamTab UI. See plan §1.5.
MEMORY_CATEGORIES = ("daily", "topics", "projects", "insights", "root")

# Valid importance levels.
IMPORTANCE_LEVELS = ("critical", "high", "medium", "low")


#: One-line description per category surfaced in the system-prompt
#: vault map. Geny-specific labels — fed to the executor's
#: ``IndexHandle.render_vault_map(category_descriptions=...)`` so the
#: rendered block matches the legacy operator-prompt layout.
CATEGORY_DESCRIPTIONS: Dict[str, str] = {
    "conversations": "Per-session conversation rollups, split by counterpart bucket (user / reflection / dm / system).",
    "dms": "Per-counterpart-per-day DM index bundles.",
    "critical": "Always-pinned facts about the user, persona, and binding decisions; injected into every prompt.",
    "insights": "LLM-distilled facts curated from past conversations.",
    "topics": "Curated subject pages (free-form notes the agent can read/write).",
    "projects": "Curated initiative pages tracking ongoing work.",
    "daily": "Per-execution result cards (one per agent run).",
    "executions": "Append-only execution-summary stream organised by date.",
    "compactions": "Compaction artefacts written by the s02 context compactor.",
    "root": "Root-level files (MEMORY.md and any uncategorised .md).",
}


@dataclass
class MemoryFileInfo:
    """Metadata for a single memory file. Caller-compatible shape."""
    filename: str = ""
    title: str = ""
    category: str = "topics"
    tags: List[str] = field(default_factory=list)
    importance: str = "medium"
    created: str = ""
    modified: str = ""
    source: str = "system"
    char_count: int = 0
    links_to: List[str] = field(default_factory=list)
    linked_from: List[str] = field(default_factory=list)
    summary: Optional[str] = None
    # InteractionEvent dimensions — only populated for ``conversations/``
    # files whose frontmatter (or ``metadata`` extension) carries them.
    # Empty string elsewhere; legacy filters bypass when empty.
    event_id: str = ""
    kind: str = ""
    direction: str = ""
    counterpart: str = ""
    counterpart_role: str = ""
    linked_event_id: str = ""
    session_id: str = ""
    turn_count: int = 0
    event_ids: List[str] = field(default_factory=list)
    kinds: List[str] = field(default_factory=list)
    counterparts: List[str] = field(default_factory=list)
    importance_max: str = ""
    date_first: str = ""
    date_last: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "MemoryFileInfo":
        fields = {k for k in cls.__dataclass_fields__}
        filtered = {k: v for k, v in d.items() if k in fields}
        return cls(**filtered)


@dataclass
class VectorSearchResult:
    """Single hit from a vector similarity search.

    Mirrors the dataclass that lived under the old
    ``service.memory.vector_store`` so any caller that read ``.text`` /
    ``.source_file`` / ``.score`` / ``.chunk_index`` keeps working
    without modification. The session manager produces these from
    ``provider.vector().search(...)`` payloads.
    """

    text: str
    source_file: str
    score: float
    chunk_index: int = 0
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class MemoryIndex:
    """Full index snapshot. Caller-compatible shape."""
    files: Dict[str, MemoryFileInfo] = field(default_factory=dict)
    tag_map: Dict[str, List[str]] = field(default_factory=dict)
    link_graph: Dict[str, List[str]] = field(default_factory=dict)
    last_rebuilt: str = ""
    total_chars: int = 0
    total_files: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "files": {k: v.to_dict() for k, v in self.files.items()},
            "tag_map": self.tag_map,
            "link_graph": self.link_graph,
            "last_rebuilt": self.last_rebuilt,
            "total_chars": self.total_chars,
            "total_files": self.total_files,
        }


@dataclass
class MemoryEntry:
    """A single piece of stored memory.

    Both long-term (markdown heading sections) and short-term
    (transcript turns) are normalized into this structure.
    """
    source: MemorySource
    content: str
    timestamp: Optional[datetime] = None
    filename: Optional[str] = None
    line_start: Optional[int] = None
    line_end: Optional[int] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    # Structured metadata (populated for frontmatter-enabled files)
    title: Optional[str] = None
    category: Optional[str] = None
    tags: List[str] = field(default_factory=list)
    importance: str = "medium"
    links_to: List[str] = field(default_factory=list)
    linked_from: List[str] = field(default_factory=list)
    summary: Optional[str] = None

    @property
    def char_count(self) -> int:
        return len(self.content)

    @property
    def token_estimate(self) -> int:
        """Rough token estimate (3 chars ≈ 1 token for mixed en/ko)."""
        return max(1, len(self.content) // 3)

    def to_dict(self) -> Dict[str, Any]:
        """Serialize to a plain dict for API responses."""
        return {
            "source": self.source.value,
            "content": self.content,
            "timestamp": self.timestamp.isoformat() if self.timestamp else None,
            "filename": self.filename,
            "title": self.title,
            "category": self.category,
            "tags": self.tags,
            "importance": self.importance,
            "links_to": self.links_to,
            "linked_from": self.linked_from,
            "summary": self.summary,
            "char_count": self.char_count,
            "metadata": self.metadata,
        }


@dataclass
class MemorySearchResult:
    """A search hit with relevance score."""
    entry: MemoryEntry
    score: float = 0.0
    snippet: str = ""
    match_type: str = "keyword"  # "keyword" | "recency" | "combined"

    @property
    def source(self) -> MemorySource:
        return self.entry.source

    @property
    def content(self) -> str:
        return self.entry.content

    def to_dict(self) -> Dict[str, Any]:
        """Serialize for API responses."""
        return {
            "entry": self.entry.to_dict(),
            "score": self.score,
            "snippet": self.snippet,
            "match_type": self.match_type,
        }


@dataclass
class MemoryStats:
    """Aggregate statistics about the memory store."""
    long_term_entries: int = 0
    short_term_entries: int = 0
    long_term_chars: int = 0
    short_term_chars: int = 0
    total_files: int = 0
    last_write: Optional[datetime] = None
    # Structured memory stats
    categories: Dict[str, int] = field(default_factory=dict)
    total_tags: int = 0
    total_links: int = 0

    def to_dict(self) -> Dict[str, Any]:
        """Serialize for API responses."""
        return {
            "long_term_entries": self.long_term_entries,
            "short_term_entries": self.short_term_entries,
            "long_term_chars": self.long_term_chars,
            "short_term_chars": self.short_term_chars,
            "total_files": self.total_files,
            "last_write": self.last_write.isoformat() if self.last_write else None,
            "categories": self.categories,
            "total_tags": self.total_tags,
            "total_links": self.total_links,
        }
