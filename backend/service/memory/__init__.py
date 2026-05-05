"""
Memory subsystem for Geny Agent.

STM (transcripts/session.jsonl) and LTM (memory/*.md) are both owned
by the executor's ``MemoryProvider`` after Sprint 3:
    - 1.21.0 retired ``ShortTermMemory``
    - Sprint 3 step 2 retired ``LongTermMemory``

``SessionMemoryManager`` reaches for both through inline
``_stm_*`` / ``_ltm_*`` helpers; no host-side adapter classes exist.

Vector layer is an adapter on top of ``MemoryProvider.vector()``.

Structured memory layer (Obsidian-like):
    StructuredMemoryWriter — frontmatter-based note creation
    MemoryIndexManager     — in-memory file index with tags/links

Public API:
    SessionMemoryManager   — per-session facade
    VectorMemoryManager    — vector adapter over provider.vector()
    MemorySearchResult     — search hit dataclass
"""

from service.memory.manager import SessionMemoryManager
from service.memory.vector_memory import VectorMemoryManager
from service.memory.structured_writer import StructuredMemoryWriter
from service.memory.index import MemoryIndexManager
from service.memory.types import MemoryEntry, MemorySearchResult, MemoryStats
from service.memory.global_memory import GlobalMemoryManager, get_global_memory_manager
from service.memory.curated_knowledge import CuratedKnowledgeManager, get_curated_knowledge_manager

__all__ = [
    "SessionMemoryManager",
    "VectorMemoryManager",
    "StructuredMemoryWriter",
    "MemoryIndexManager",
    "MemoryEntry",
    "MemorySearchResult",
    "MemoryStats",
    "CuratedKnowledgeManager",
    "get_curated_knowledge_manager",
]
