"""
Long-Term Memory (Vector DB) Configuration.

Controls FAISS-backed vector retrieval for long-term memory:
- Enable / disable vector search
- Embedding provider & model selection
- Chunking parameters (size, overlap)
- Retrieval parameters (top-k, score threshold)
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List

from service.config.base import BaseConfig, ConfigField, FieldType, register_config
from service.config.sub_config.general.env_utils import env_sync, read_env_defaults


# ── Memory engine options ─────────────────────────────────────────────

MEMORY_ENGINE_OPTIONS = [
    {"value": "composite", "label": "Composite (API embeddings)"},
    {"value": "synapse", "label": "Synapse (local · learnable · no API)"},
]

# ── Embedding provider options ────────────────────────────────────────

EMBEDDING_PROVIDER_OPTIONS = [
    {"value": "openai", "label": "OpenAI"},
    {"value": "google", "label": "Google (Gemini)"},
    {"value": "anthropic", "label": "Anthropic (Voyage)"},
]

OPENAI_MODEL_OPTIONS = [
    {"value": "text-embedding-3-small", "label": "text-embedding-3-small (1536d, cheap)", "group": "openai"},
    {"value": "text-embedding-3-large", "label": "text-embedding-3-large (3072d, best)", "group": "openai"},
    {"value": "text-embedding-ada-002", "label": "text-embedding-ada-002 (1536d, legacy)", "group": "openai"},
]

GOOGLE_MODEL_OPTIONS = [
    {"value": "text-embedding-004", "label": "text-embedding-004 (768d)", "group": "google"},
    {"value": "embedding-001", "label": "embedding-001 (768d, legacy)", "group": "google"},
]

ANTHROPIC_MODEL_OPTIONS = [
    {"value": "voyage-3-large", "label": "voyage-3-large (1024d, best)", "group": "anthropic"},
    {"value": "voyage-3", "label": "voyage-3 (1024d)", "group": "anthropic"},
    {"value": "voyage-3-lite", "label": "voyage-3-lite (512d, fast)", "group": "anthropic"},
    {"value": "voyage-code-3", "label": "voyage-code-3 (1024d, code-optimized)", "group": "anthropic"},
]

ALL_MODEL_OPTIONS = OPENAI_MODEL_OPTIONS + GOOGLE_MODEL_OPTIONS + ANTHROPIC_MODEL_OPTIONS


@register_config
@dataclass
class LTMConfig(BaseConfig):
    """Long-Term Memory vector search settings."""

    # ── Toggle ──
    # Default ON: the default engine (Synapse) is local and makes zero API
    # calls, so long-term vector memory works out of the box with no cost and
    # no key to configure. Hosts can still turn it off in settings.
    enabled: bool = True

    # ── Memory engine ──
    #: "synapse" (default): local, learnable, zero-API-call engine (BM25 +
    #: local embeddings + typed-edge PageRank + online-learned ranker) — Geny's
    #: native memory logic. embedding_provider/model/key below are unused here.
    #: "composite": file notes + API-embedding vector layer (needs a key).
    memory_engine: str = "synapse"
    #: Synapse local embedding dimension (synapse engine only).
    synapse_dim: int = 256

    # ── Embedding provider ──
    embedding_provider: str = "openai"
    embedding_model: str = "text-embedding-3-small"
    embedding_api_key: str = ""

    # ── Chunking ──
    chunk_size: int = 1024
    chunk_overlap: int = 256

    # ── Retrieval ──
    top_k: int = 6
    score_threshold: float = 0.35
    max_inject_chars: int = 10000

    # ── Curated Knowledge ──
    curated_knowledge_enabled: bool = False
    curated_vector_enabled: bool = False
    curated_inject_budget: int = 5000
    curated_max_results: int = 5

    # ── Auto-Curation Pipeline ──
    auto_curation_enabled: bool = False
    auto_curation_use_llm: bool = True
    auto_curation_quality_threshold: float = 0.6

    # ── Auto-Curation Scheduling ──
    auto_curation_schedule_enabled: bool = False
    auto_curation_interval_hours: int = 24
    auto_curation_max_notes_per_run: int = 20
    auto_curation_last_run: str = ""

    # ── User Opsidian Read Access ──
    # Default to True so the agent can browse / read the *user's own*
    # personal vault out of the box. The data belongs to the user, the
    # agent runs on the user's behalf, and gating it default-off only
    # produced confusing "User Opsidian index access is not enabled"
    # responses when the user shared notes via the whiteboard. Hosts
    # that need stricter privacy can flip these back to False in
    # settings.json.
    user_opsidian_index_enabled: bool = True
    user_opsidian_raw_read_enabled: bool = True

    # ── Retention ──
    # What the agent writes to ITSELF, and how much of it survives. The
    # screen-observation loop wrote ~757 notes/day and nothing removed any
    # of them; 99.5% of a production vault was machine-authored.
    observation_max_notes: int = 20
    note_retention_days: int = 30
    note_retention_max_per_category: int = 4000

    # ── Env mapping (for optional .env fallback) ──
    _ENV_MAP = {
        "embedding_api_key": "LTM_EMBEDDING_API_KEY",
        "observation_max_notes": "GENY_SCREEN_OBS_MAX_NOTES",
        "note_retention_days": "GENY_NOTE_RETENTION_DAYS",
        "note_retention_max_per_category": "GENY_NOTE_RETENTION_MAX_PER_CATEGORY",
    }

    # ──────────────────────────────────────────────────────────────────
    # BaseConfig interface
    # ──────────────────────────────────────────────────────────────────

    @classmethod
    def get_default_instance(cls) -> "LTMConfig":
        defaults = read_env_defaults(cls._ENV_MAP, cls.__dataclass_fields__)
        return cls(**defaults)

    @classmethod
    def is_enabled(cls) -> bool:
        """Quick check: is long-term memory enabled in the current config?

        Loads the persisted LTMConfig via the global config manager
        and returns ``config.enabled``.  Returns ``False`` on any
        error (config system unavailable, first run, etc.).
        """
        try:
            from service.config import get_config_manager

            mgr = get_config_manager()
            config = mgr.load_config(cls)
            return config is not None and config.enabled
        except Exception:
            return False

    @classmethod
    def get_config_name(cls) -> str:
        return "ltm"

    @classmethod
    def get_display_name(cls) -> str:
        return "Long-Term Memory"

    @classmethod
    def get_description(cls) -> str:
        return (
            "Semantic long-term memory retrieval. Defaults to Synapse — a "
            "local, learnable engine with no API calls; switch to Composite for "
            "API embeddings. Configure the engine and search parameters."
        )

    @classmethod
    def get_category(cls) -> str:
        return "general"

    @classmethod
    def get_icon(cls) -> str:
        return "brain"

    @classmethod
    def get_i18n(cls) -> Dict[str, Dict[str, Any]]:
        return {
            "ko": {
                "display_name": "Long-Term Memory (Vector DB)",
                "description": (
                    "의미 기반 장기 기억 검색. 기본값은 Synapse — API 호출 없이 로컬에서 "
                    "학습하는 경량 엔진이며, API 임베딩이 필요하면 Composite로 전환하세요. "
                    "엔진과 검색 파라미터를 설정합니다."
                ),
                "groups": {
                    "toggle": "Enable",
                    "synapse": "Synapse 설정 (로컬 엔진)",
                    "embedding": "Embedding Settings",
                    "chunking": "Chunking Settings",
                    "retrieval": "Retrieval Settings",
                    "curated": "Curated Knowledge",
                    "auto_curation": "Auto-Curation Pipeline",
                    "auto_curation_schedule": "Curation Schedule",
                    "user_opsidian": "User Opsidian Access",
                    "retention": "기록 보관 정책",
                },
                "fields": {
                    "enabled": {
                        "label": "Enable Long-Term Memory Vector Search",
                        "description": "Enable FAISS vector DB-based semantic search",
                    },
                    "memory_engine": {
                        "label": "메모리 엔진",
                        "description": ("Synapse는 API 호출 없이 로컬에서 학습하는 경량 "
                                        "엔진입니다(Geny 기본값). Composite는 API 임베딩을 "
                                        "쓰며 키가 필요합니다."),
                    },
                    "synapse_dim": {
                        "label": "로컬 임베딩 차원",
                        "description": ("Synapse 로컬 정적 임베딩의 차원입니다. 256이 무난한 "
                                        "기본값이며, 크면 약간 더 정밀하지만 무거워집니다."),
                    },
                    "embedding_provider": {
                        "label": "Embedding Provider",
                        "description": "API provider for converting text to vectors",
                    },
                    "embedding_model": {
                        "label": "Embedding Model",
                        "description": "Embedding model for the selected provider",
                    },
                    "embedding_api_key": {
                        "label": "임베딩 API 키 (오버라이드)",
                        "description": (
                            "임베딩 전용 별도 키가 필요할 때만 입력하세요. "
                            "비워두면 LLM & Provider 설정의 프로바이더 키를 "
                            "사용합니다(권장 — 키는 한 곳에서만 관리)."
                        ),
                        "placeholder": "(비움 = LLM & Provider 키 사용)",
                    },
                    "chunk_size": {
                        "label": "Chunk Size",
                        "description": "Unit size (in characters) for splitting memory text",
                    },
                    "chunk_overlap": {
                        "label": "Chunk Overlap",
                        "description": "Number of overlapping characters between adjacent chunks",
                    },
                    "top_k": {
                        "label": "Top-K Results",
                        "description": "Maximum number of results to return per vector search",
                    },
                    "score_threshold": {
                        "label": "Similarity Threshold",
                        "description": "Results below this value are excluded (0 = no filter)",
                    },
                    "max_inject_chars": {
                        "label": "Max Inject Characters",
                        "description": "Maximum number of characters from vector search results to inject into context",
                    },
                    "curated_knowledge_enabled": {
                        "label": "Enable Curated Knowledge",
                        "description": "Enable the curated knowledge layer between User Opsidian and agent memory",
                    },
                    "curated_vector_enabled": {
                        "label": "Curated Vector Search",
                        "description": "Enable FAISS vector search within curated knowledge",
                    },
                    "curated_inject_budget": {
                        "label": "Curated Inject Budget",
                        "description": "Character budget for curated knowledge injected into context",
                    },
                    "curated_max_results": {
                        "label": "Curated Max Results",
                        "description": "Maximum number of curated knowledge notes to inject",
                    },
                    "auto_curation_enabled": {
                        "label": "Enable Auto-Curation",
                        "description": "Automatically curate high-quality notes from User Opsidian",
                    },
                    "auto_curation_use_llm": {
                        "label": "LLM-Assisted Curation",
                        "description": "Use LLM to evaluate and transform notes during curation",
                    },
                    "auto_curation_quality_threshold": {
                        "label": "Quality Threshold",
                        "description": "Minimum quality score (0-1) for auto-curation acceptance",
                    },
                    "auto_curation_schedule_enabled": {
                        "label": "Enable Scheduled Curation",
                        "description": "Run curation automatically on a periodic schedule",
                    },
                    "auto_curation_interval_hours": {
                        "label": "Curation Interval (hours)",
                        "description": "How often to run automatic curation (in hours)",
                    },
                    "auto_curation_max_notes_per_run": {
                        "label": "Max Notes Per Run",
                        "description": "Maximum number of notes to curate per scheduled run",
                    },
                    "auto_curation_last_run": {
                        "label": "Last Run",
                        "description": "Timestamp of the last automatic curation run",
                    },
                    "user_opsidian_index_enabled": {
                        "label": "Opsidian Index Access",
                        "description": "Allow agent to browse User Opsidian note index",
                    },
                    "user_opsidian_raw_read_enabled": {
                        "label": "Opsidian Raw Read",
                        "description": "Allow agent to read individual User Opsidian notes",
                    },
                },
            }
        }

    @classmethod
    def get_fields_metadata(cls) -> List[ConfigField]:
        return [
            # ── Toggle ──
            # ── Retention ──
            ConfigField(
                name="observation_max_notes",
                field_type=FieldType.NUMBER,
                label="화면 관찰 보관 개수",
                description=(
                    "화면 관찰은 방금 화면에 무엇이 있었는지에 대한 메모이지 "
                    "사용자와 주고받은 기록이 아닙니다. 에이전트가 실제로 "
                    "언급한 장면은 실행 기록에 첨부되어 따로 남으므로, "
                    "여기서는 최근 N개만 보관합니다. 0이면 개수 제한 없음."
                ),
                default=20,
                min_value=0,
                max_value=2000,
                group="retention",
                apply_change=env_sync("GENY_SCREEN_OBS_MAX_NOTES"),
            ),
            ConfigField(
                name="note_retention_days",
                field_type=FieldType.NUMBER,
                label="자동 생성 노트 보관 기간 (일)",
                description=(
                    "관찰·실행 기록처럼 에이전트가 스스로 만든 노트를 며칠까지 "
                    "보관할지. 사용자가 쓴 노트와 대화 기록, critical 표시, "
                    "요약·원장 파일은 대상이 아닙니다. 0이면 기간 제한 없음."
                ),
                default=30,
                min_value=0,
                max_value=3650,
                group="retention",
                apply_change=env_sync("GENY_NOTE_RETENTION_DAYS"),
            ),
            ConfigField(
                name="note_retention_max_per_category",
                field_type=FieldType.NUMBER,
                label="자동 생성 노트 범주별 보관 개수",
                description=(
                    "기간만으로는 총량이 묶이지 않습니다 — 생성 속도가 바뀌면 "
                    "보관량도 따라 바뀝니다. 범주마다 최신 N개까지만 남깁니다. "
                    "0이면 개수 제한 없음."
                ),
                default=4000,
                min_value=0,
                max_value=100000,
                group="retention",
                apply_change=env_sync("GENY_NOTE_RETENTION_MAX_PER_CATEGORY"),
            ),

            ConfigField(
                name="enabled",
                field_type=FieldType.BOOLEAN,
                label="Enable Vector Search",
                description="Enable FAISS-based semantic search for long-term memory",
                default=True,
                group="toggle",
            ),

            # ── Engine ──
            ConfigField(
                name="memory_engine",
                field_type=FieldType.SELECT,
                label="Memory Engine",
                description=("Synapse runs a local, learnable engine with no "
                             "API calls (Geny's default). Composite uses API "
                             "embeddings and needs a key."),
                default="synapse",
                options=MEMORY_ENGINE_OPTIONS,
                group="toggle",
            ),

            # ── Synapse (local engine only) ──
            ConfigField(
                name="synapse_dim",
                field_type=FieldType.NUMBER,
                label="Local Embedding Dimension",
                description=("Dimension of Synapse's local static embeddings. "
                             "256 is a good default; larger is slightly sharper "
                             "but heavier."),
                default=256,
                min_value=64,
                max_value=1024,
                group="synapse",
                visible_when={"memory_engine": ["synapse"]},
            ),

            # ── Embedding (composite engine only) ──
            ConfigField(
                name="embedding_provider",
                field_type=FieldType.SELECT,
                label="Embedding Provider",
                description="API provider for converting text to vectors",
                default="openai",
                options=EMBEDDING_PROVIDER_OPTIONS,
                group="embedding",
                visible_when={"memory_engine": ["composite"]},
            ),
            ConfigField(
                name="embedding_model",
                field_type=FieldType.SELECT,
                label="Embedding Model",
                description="Model for the selected provider",
                default="text-embedding-3-small",
                options=ALL_MODEL_OPTIONS,
                group="embedding",
                depends_on="embedding_provider",
                visible_when={"memory_engine": ["composite"]},
            ),
            ConfigField(
                name="embedding_api_key",
                field_type=FieldType.PASSWORD,
                label="Embedding API Key (override)",
                description=(
                    "Optional embedding-only key. Leave EMPTY to use the "
                    "provider key from the LLM & Provider settings section "
                    "(recommended — one key, managed in one place)."
                ),
                required=False,
                placeholder="(empty = LLM & Provider key)",
                group="embedding",
                secure=True,
                apply_change=env_sync("LTM_EMBEDDING_API_KEY"),
                visible_when={"memory_engine": ["composite"]},
            ),

            # ── Chunking (composite engine only — Synapse stores one vector
            #    per note, so there is nothing to chunk) ──
            ConfigField(
                name="chunk_size",
                field_type=FieldType.NUMBER,
                label="Chunk Size (chars)",
                description="Character count per memory text chunk",
                default=1024,
                min_value=128,
                max_value=4096,
                group="chunking",
                visible_when={"memory_engine": ["composite"]},
            ),
            ConfigField(
                name="chunk_overlap",
                field_type=FieldType.NUMBER,
                label="Chunk Overlap (chars)",
                description="Overlapping characters between adjacent chunks",
                default=256,
                min_value=0,
                max_value=512,
                group="chunking",
                visible_when={"memory_engine": ["composite"]},
            ),

            # ── Retrieval ──
            ConfigField(
                name="top_k",
                field_type=FieldType.NUMBER,
                label="Top-K Results",
                description="Maximum number of results returned per vector search",
                default=6,
                min_value=1,
                max_value=30,
                group="retrieval",
            ),
            ConfigField(
                name="score_threshold",
                field_type=FieldType.NUMBER,
                label="Score Threshold",
                description="Filter out results below this cosine similarity (0 = no filter)",
                default=0.35,
                min_value=0.0,
                max_value=1.0,
                group="retrieval",
            ),
            ConfigField(
                name="max_inject_chars",
                field_type=FieldType.NUMBER,
                label="Max Inject Characters",
                description="Character budget for vector search results injected into context",
                default=10000,
                min_value=500,
                max_value=30000,
                group="retrieval",
            ),

            # ── Curated Knowledge ──
            ConfigField(
                name="curated_knowledge_enabled",
                field_type=FieldType.BOOLEAN,
                label="Enable Curated Knowledge",
                description="Enable the curated knowledge layer between User Opsidian and agent memory",
                default=False,
                group="curated",
            ),
            ConfigField(
                name="curated_vector_enabled",
                field_type=FieldType.BOOLEAN,
                label="Curated Vector Search",
                description="Enable FAISS vector search within curated knowledge",
                default=False,
                group="curated",
            ),
            ConfigField(
                name="curated_inject_budget",
                field_type=FieldType.NUMBER,
                label="Curated Inject Budget (chars)",
                description="Character budget for curated knowledge in context",
                default=5000,
                min_value=500,
                max_value=20000,
                group="curated",
            ),
            ConfigField(
                name="curated_max_results",
                field_type=FieldType.NUMBER,
                label="Curated Max Results",
                description="Maximum curated notes to inject per turn",
                default=5,
                min_value=1,
                max_value=20,
                group="curated",
            ),

            # ── Auto-Curation Pipeline ──
            ConfigField(
                name="auto_curation_enabled",
                field_type=FieldType.BOOLEAN,
                label="Enable Auto-Curation",
                description="Automatically curate from User Opsidian",
                default=False,
                group="auto_curation",
            ),
            ConfigField(
                name="auto_curation_use_llm",
                field_type=FieldType.BOOLEAN,
                label="LLM-Assisted Curation",
                description="Use LLM for quality evaluation during curation",
                default=True,
                group="auto_curation",
            ),
            ConfigField(
                name="auto_curation_quality_threshold",
                field_type=FieldType.NUMBER,
                label="Quality Threshold",
                description="Minimum quality score (0.0-1.0) for acceptance",
                default=0.6,
                min_value=0.0,
                max_value=1.0,
                group="auto_curation",
            ),

            # ── Auto-Curation Scheduling ──
            ConfigField(
                name="auto_curation_schedule_enabled",
                field_type=FieldType.BOOLEAN,
                label="Enable Scheduled Curation",
                description="Run curation automatically on a periodic schedule",
                default=False,
                group="auto_curation_schedule",
            ),
            ConfigField(
                name="auto_curation_interval_hours",
                field_type=FieldType.NUMBER,
                label="Interval (hours)",
                description="How often to run auto-curation",
                default=24,
                min_value=1,
                max_value=168,
                group="auto_curation_schedule",
            ),
            ConfigField(
                name="auto_curation_max_notes_per_run",
                field_type=FieldType.NUMBER,
                label="Max Notes Per Run",
                description="Cap on notes curated per scheduled run",
                default=20,
                min_value=1,
                max_value=100,
                group="auto_curation_schedule",
            ),
            ConfigField(
                name="auto_curation_last_run",
                field_type=FieldType.STRING,
                label="Last Run",
                description="Timestamp of the last automatic curation run (read-only)",
                default="",
                group="auto_curation_schedule",
            ),

            # ── User Opsidian Access ──
            ConfigField(
                name="user_opsidian_index_enabled",
                field_type=FieldType.BOOLEAN,
                label="Opsidian Index Access",
                description="Let agents browse User Opsidian note index",
                default=False,
                group="user_opsidian",
            ),
            ConfigField(
                name="user_opsidian_raw_read_enabled",
                field_type=FieldType.BOOLEAN,
                label="Opsidian Raw Read",
                description="Let agents read individual User Opsidian notes",
                default=False,
                group="user_opsidian",
            ),
        ]
