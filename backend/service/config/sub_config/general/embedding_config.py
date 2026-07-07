"""Central embedding settings — the Model & Provider panel's Embedding card.

One place answers "which provider/model embeds documents": the knowledge
repository reads this for every ingest and search. Each document card
records the model it was embedded with, so changing the model here marks
existing documents stale and the UI offers re-embedding.

Hidden from the generic settings list (``is_user_visible = False``) —
the Model & Provider panel is the only editor, same pattern as
``LLMCredentialsConfig``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Tuple

from service.config.base import BaseConfig, ConfigField, FieldType, register_config

# provider → {model: dimension}. The single registry every consumer
# (knowledge service, panel model pickers) reads.
EMBEDDING_MODELS: Dict[str, Dict[str, int]] = {
    "openai": {
        "text-embedding-3-large": 3072,
        "text-embedding-3-small": 1536,
        "text-embedding-ada-002": 1536,
    },
    "google": {
        "gemini-embedding-001": 3072,
        "text-embedding-004": 768,
    },
}

DEFAULT_EMBEDDING_PROVIDER = "openai"
DEFAULT_EMBEDDING_MODEL = "text-embedding-3-large"


def resolve_embedding_spec(provider: str, model: str) -> Tuple[str, str, int]:
    """Normalise a (provider, model) pair against the registry, falling
    back to the default spec when either half is unknown."""
    provider = (provider or "").strip().lower()
    model = (model or "").strip()
    models = EMBEDDING_MODELS.get(provider)
    if models and model in models:
        return provider, model, models[model]
    if models:  # known provider, unknown model → provider's first model
        first = next(iter(models))
        return provider, first, models[first]
    return (
        DEFAULT_EMBEDDING_PROVIDER,
        DEFAULT_EMBEDDING_MODEL,
        EMBEDDING_MODELS[DEFAULT_EMBEDDING_PROVIDER][DEFAULT_EMBEDDING_MODEL],
    )


@register_config
@dataclass
class EmbeddingSettingsConfig(BaseConfig):
    """Which provider/model embeds documents (knowledge repository)."""

    provider: str = DEFAULT_EMBEDDING_PROVIDER
    model: str = DEFAULT_EMBEDDING_MODEL

    @classmethod
    def get_config_name(cls) -> str:
        return "embedding_settings"

    @classmethod
    def get_display_name(cls) -> str:
        return "Embedding Settings"

    @classmethod
    def get_description(cls) -> str:
        return (
            "Provider + model used to embed knowledge documents. Edited "
            "through the Model & Provider panel's Embedding card; the key "
            "comes from the same panel's provider cards."
        )

    @classmethod
    def get_category(cls) -> str:
        return "general"

    @classmethod
    def is_user_visible(cls) -> bool:
        return False  # Model & Provider panel is the only editor

    @classmethod
    def get_fields_metadata(cls) -> List[ConfigField]:
        provider_options = [
            {"value": p, "label": p} for p in EMBEDDING_MODELS
        ]
        model_options = [
            {"value": m, "label": f"{m} ({p}, {dim}d)"}
            for p, models in EMBEDDING_MODELS.items()
            for m, dim in models.items()
        ]
        return [
            ConfigField(
                name="provider",
                field_type=FieldType.SELECT,
                label="Embedding Provider",
                options=provider_options,
                default=DEFAULT_EMBEDDING_PROVIDER,
            ),
            ConfigField(
                name="model",
                field_type=FieldType.SELECT,
                label="Embedding Model",
                options=model_options,
                default=DEFAULT_EMBEDDING_MODEL,
            ),
        ]

    def validate(self) -> List[str]:
        # Unknown pairs are normalised by resolve_embedding_spec at read
        # time rather than rejected here — never block a config save.
        return []
