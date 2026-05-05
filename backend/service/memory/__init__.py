"""
Memory subsystem for Geny Agent.

Long-term memory backed by files inside the session's storage
directory; short-term memory (transcripts/session.jsonl) is owned
entirely by the executor's ``MemoryProvider.stm()`` after 1.21.0 —
``SessionMemoryManager`` reaches for it through inline ``_stm_*``
helpers; no host-side ``ShortTermMemory`` adapter exists.

Vector layer is an adapter on top of ``MemoryProvider.vector()``.

Structured memory layer (Obsidian-like):
    StructuredMemoryWriter — frontmatter-based note creation
    MemoryIndexManager     — in-memory file index with tags/links

Public API:
    SessionMemoryManager   — per-session facade
    LongTermMemory         — MEMORY.md file I/O
    VectorMemoryManager    — vector adapter over provider.vector()
    MemorySearchResult     — search hit dataclass
"""

from service.memory.manager import SessionMemoryManager
from service.memory.long_term import LongTermMemory
from service.memory.vector_memory import VectorMemoryManager
from service.memory.structured_writer import StructuredMemoryWriter
from service.memory.index import MemoryIndexManager
from service.memory.types import MemoryEntry, MemorySearchResult, MemoryStats
from service.memory.global_memory import GlobalMemoryManager, get_global_memory_manager
from service.memory.curated_knowledge import CuratedKnowledgeManager, get_curated_knowledge_manager

__all__ = [
    "SessionMemoryManager",
    "LongTermMemory",
    "VectorMemoryManager",
    "StructuredMemoryWriter",
    "MemoryIndexManager",
    "MemoryEntry",
    "MemorySearchResult",
    "MemoryStats",
    "CuratedKnowledgeManager",
    "get_curated_knowledge_manager",
]
