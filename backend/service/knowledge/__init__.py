"""User knowledge repository — documents in the Opsidian user vault,
chunked via Contextifier, embedded (OpenAI text-embedding-3-large),
searched through qdrant. See ``service.knowledge.service``."""

from service.knowledge.service import (
    KnowledgeService,
    KnowledgeUnavailable,
    get_knowledge_service,
)

__all__ = ["KnowledgeService", "KnowledgeUnavailable", "get_knowledge_service"]
