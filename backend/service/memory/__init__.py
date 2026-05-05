"""
Memory subsystem for Geny Agent.

After Sprint 3 + Cleanup, every host-side memory surface routes through
the executor's ``MemoryProvider`` directly:

- ``SessionMemoryManager`` calls ``provider.stm()`` / ``provider.ltm()`` /
  ``provider.notes()`` / ``provider.index()`` / ``provider.vector()`` via
  inline helpers. No host-side adapter fields.
- The multi-tenant managers (``GlobalMemoryManager`` /
  ``CuratedKnowledgeManager`` / ``UserOpsidianManager``) each own their
  own single-tenant ``MemoryProvider`` (file-backed).

Public API:
    SessionMemoryManager   — per-session facade
    VectorMemoryManager    — kept as a slim ``provider.vector()`` adapter
                              for callers that pre-date the inline helpers
    MemoryEntry / MemorySearchResult / MemoryStats — search hit shapes
    GlobalMemoryManager / CuratedKnowledgeManager / UserOpsidianManager
"""

from service.memory.manager import SessionMemoryManager
from service.memory.vector_memory import VectorMemoryManager
from service.memory.structured_writer import StructuredMemoryWriter
from service.memory.types import MemoryEntry, MemorySearchResult, MemoryStats
from service.memory.global_memory import GlobalMemoryManager, get_global_memory_manager
from service.memory.curated_knowledge import CuratedKnowledgeManager, get_curated_knowledge_manager

__all__ = [
    "SessionMemoryManager",
    "VectorMemoryManager",
    "StructuredMemoryWriter",
    "MemoryEntry",
    "MemorySearchResult",
    "MemoryStats",
    "CuratedKnowledgeManager",
    "get_curated_knowledge_manager",
]
