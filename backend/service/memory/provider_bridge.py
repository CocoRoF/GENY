"""Bridge from Geny's LTMConfig + storage layout → geny-executor `MemoryProvider`.

Single source of truth for *how* Geny constructs the executor's
`MemoryProvider` for one agent session. The shape produced here is
the canonical config dict consumed by
:meth:`geny_executor.memory.factory.MemoryProviderFactory.build` and
matches the composite-with-curated layout described in
``docs/planning/MEMORY_PROVIDER_UNIFICATION_PLAN.md``.

What gets composed:

    composite
      ├─ providers["session"]      file, root=<storage_path>
      └─ providers["user_curated"] file, root=<storage_root>/_curated_knowledge/<user>
                                   (only when curated_knowledge_enabled)
      layers          → session  (stm, ltm, notes, vector, index)
      scope_providers → session, user (when curated set up)

The session delegate carries the embedding client when LTM is
enabled — its auto-vector hook indexes every note write. The
user-scoped curated delegate carries the same embedding when
``curated_vector_enabled`` is on; otherwise it stays markdown-only.

This module is intentionally tiny: it owns the `LTMConfig → dict`
mapping and nothing else. Anything that needs a live `MemoryProvider`
should call :func:`build_memory_provider` (which wraps the factory)
rather than re-deriving the config.
"""

from __future__ import annotations

from logging import getLogger
from pathlib import Path
from typing import Any, Dict, Optional

logger = getLogger(__name__)


_DEFAULT_CURATED_DIRNAME = "_curated_knowledge"


def _embedding_config(ltm_config: Any) -> Optional[Dict[str, Any]]:
    """Materialise the embedding spec for the executor factory.

    Honours an explicit ``embedding_api_key`` first, then falls back
    to the provider's standard env var (``OPENAI_API_KEY`` etc.) so
    a host that already configured the LLM key doesn't need to enter
    the same secret twice.

    2.2.0 split: the returned spec carries only *what* to build
    (``provider`` / ``model``). The API key — the *how to
    authenticate* half — travels in the :class:`CredentialBundle`
    built by :func:`_embedding_credentials` and passed to
    ``MemoryProviderFactory(credentials=...)``. LTMConfig stays the
    single source of the values; only the transport changed, closing
    the parallel env-ladder channel inside the executor's embedding
    clients (which now logs a one-time deprecation warning when hit).
    """
    resolved = _resolve_embedding_values(ltm_config)
    if resolved is None:
        return None
    provider, model, _api_key = resolved
    return {"provider": provider, "model": model}


def _resolve_embedding_values(ltm_config: Any) -> Optional[tuple]:
    """Resolve ``(provider, model, api_key)`` from LTMConfig (+ env
    value fallbacks). ``None`` when LTM is off, the spec is incomplete,
    or no key can be sourced — the vector layer is then omitted."""
    if not getattr(ltm_config, "enabled", False):
        return None

    provider = (getattr(ltm_config, "embedding_provider", "") or "").strip()
    model = (getattr(ltm_config, "embedding_model", "") or "").strip()
    if not provider or not model:
        return None

    api_key = (getattr(ltm_config, "embedding_api_key", "") or "").strip()
    if not api_key and provider in ("openai", "google"):
        # Central LLM & Provider key — the user pasted the key once in
        # settings; every service reads it from there.
        try:
            from service.config.credentials import resolve_provider_key

            api_key = resolve_provider_key(provider)
        except Exception:  # noqa: BLE001
            api_key = ""
    if not api_key:
        # Provider-specific env fallbacks — legacy value sourcing for
        # providers without a central card (voyage) / pre-config hosts.
        import os

        env_keys = {
            "openai": ("LTM_EMBEDDING_API_KEY", "OPENAI_API_KEY"),
            "voyage": ("LTM_EMBEDDING_API_KEY", "VOYAGE_API_KEY"),
            "anthropic": ("LTM_EMBEDDING_API_KEY", "VOYAGE_API_KEY"),
            "google": ("LTM_EMBEDDING_API_KEY", "GOOGLE_API_KEY"),
        }
        for env_name in env_keys.get(provider, ("LTM_EMBEDDING_API_KEY",)):
            api_key = os.environ.get(env_name, "").strip()
            if api_key:
                break

    if not api_key:
        logger.info(
            "LTM embedding not configured (provider=%s model=%s) — "
            "vector layer will be omitted",
            provider, model,
        )
        return None

    # The executor's factory accepts the same {"anthropic" → Voyage}
    # alias the Geny UI uses, but normalising to "voyage" here keeps
    # the executor descriptor honest for downstream tooling.
    if provider == "anthropic":
        provider = "voyage"

    return provider, model, api_key


def _embedding_credentials(ltm_config: Any):
    """Build the :class:`CredentialBundle` carrying the ``'embedding'``
    entry for ``MemoryProviderFactory(credentials=...)`` (2.2.0 §2.6).

    ``None`` when no embedding is configured — the factory then builds
    no embedding client at all (config remains the opt-in switch).
    """
    resolved = _resolve_embedding_values(ltm_config)
    if resolved is None:
        return None
    provider, model, api_key = resolved
    from geny_executor import CredentialBundle, ProviderCredentials

    return CredentialBundle(by_provider={
        "embedding": ProviderCredentials(
            api_key=api_key,
            extras={"provider": provider, "model": model},
        ),
    })


def _curated_root(storage_path: str | Path, username: str) -> Path:
    """Resolve the curated-knowledge root for one user.

    By default we mirror the historical Geny layout
    ``<storage_root>/_curated_knowledge/<username>``. ``storage_path``
    is the per-session directory so its grandparent is the storage
    root (``<root>/sessions/<sid>`` → ``<root>``).
    """
    sp = Path(storage_path).resolve()
    # storage_path is normally <root>/sessions/<sid>; rise twice. Be
    # lenient if a host hands a flat layout — fall back to the
    # immediate parent.
    if sp.parent.name == "sessions":
        root = sp.parent.parent
    else:
        root = sp.parent
    return root / _DEFAULT_CURATED_DIRNAME / username


def build_memory_provider_config(
    *,
    session_id: str,
    storage_path: str,
    username: Optional[str],
    ltm_config: Any,
) -> Dict[str, Any]:
    """Produce the executor `MemoryProviderFactory.build()` input dict.

    Args:
        session_id: Session identifier the executor records on every
            BackendInfo / descriptor metadata.
        storage_path: Per-session storage directory. The session
            delegate's `root`. Must already exist or be createable.
        username: Owner username. Drives the curated delegate's root
            (`<storage_root>/_curated_knowledge/<username>`) and the
            composite's `user_id`. ``None`` / empty disables the
            curated plane.
        ltm_config: Live :class:`LTMConfig` (already loaded by the
            global config manager). Read for embedding/curated/vector
            flags only — the bridge never mutates the config.

    Returns:
        A dict suitable for
        :meth:`geny_executor.memory.factory.MemoryProviderFactory.build`.
        Always returns a "composite" config so curated promotion works
        the moment the user enables it; a minimal session-only setup is
        still expressed as a composite with one delegate.
    """
    storage_path = str(storage_path)
    embedding = _embedding_config(ltm_config)

    session_cfg: Dict[str, Any] = {
        "provider": "file",
        "root": storage_path,
        "session_id": session_id,
        "scope": "session",
    }
    if embedding is not None:
        session_cfg["embedding"] = embedding

    providers: Dict[str, Dict[str, Any]] = {"session": session_cfg}
    layers = {
        "stm": "session",
        "ltm": "session",
        "notes": "session",
        "vector": "session",
        "index": "session",
    }
    scope_providers: Dict[str, str] = {"session": "session"}

    curated_enabled = bool(getattr(ltm_config, "curated_knowledge_enabled", False))
    if username and curated_enabled:
        curated_root = _curated_root(storage_path, username)
        curated_cfg: Dict[str, Any] = {
            "provider": "file",
            "root": str(curated_root),
            "scope": "user",
        }
        # Only attach embedding when curated_vector_enabled is on.
        # Without it the curated handle stays markdown-only — useful
        # for a host that wants curated promotion + keyword search
        # but isn't ready to pay embedding cost on every promote.
        curated_vec = bool(getattr(ltm_config, "curated_vector_enabled", False))
        if embedding is not None and curated_vec:
            curated_cfg["embedding"] = dict(embedding)
        providers["user_curated"] = curated_cfg
        scope_providers["user"] = "user_curated"

    return {
        "provider": "composite",
        "session_id": session_id,
        "user_id": username or "",
        "providers": providers,
        "layers": layers,
        "scope_providers": scope_providers,
    }


async def build_memory_provider(
    *,
    session_id: str,
    storage_path: str,
    username: Optional[str],
    ltm_config: Optional[Any] = None,
):
    """Build and `initialize()` a `MemoryProvider` for one session.

    Convenience wrapper that loads the LTM config when not supplied
    and runs `MemoryProviderFactory.build(...)`. Returns the live
    provider; caller is responsible for `await provider.close()` at
    session teardown.

    Failures during build are re-raised so the session creator can
    decide whether to retry with a degraded config or surface the
    error to the user. Initialisation failures are similarly
    propagated — a half-built provider is worse than no provider.
    """
    from geny_executor.memory.factory import MemoryProviderFactory

    if ltm_config is None:
        try:
            from service.config import get_config_manager
            from service.config.sub_config.general.ltm_config import LTMConfig

            mgr = get_config_manager()
            ltm_config = mgr.load_config(LTMConfig) or LTMConfig.get_default_instance()
        except Exception:  # noqa: BLE001
            logger.warning(
                "build_memory_provider: failed to load LTMConfig; "
                "falling back to disabled defaults",
                exc_info=True,
            )
            from service.config.sub_config.general.ltm_config import LTMConfig

            ltm_config = LTMConfig.get_default_instance()

    # Engine choice (LTMConfig.memory_engine): "synapse" (default — local,
    # learnable, zero-API-call, Geny's native memory logic) or "composite" (API
    # embeddings). Synapse can't go through the factory/manifest path (a custom
    # provider name isn't registered on the factory the executor builds
    # internally), so it is assembled here directly: a FileMemoryProvider
    # keeping STM/LTM/Notes as markdown, its vector layer replaced by a
    # Synapse-backed VectorHandle.
    engine = (getattr(ltm_config, "memory_engine", "synapse") or "synapse").strip()
    if engine == "synapse":
        provider = _build_synapse_provider(
            session_id=session_id, storage_path=storage_path, ltm_config=ltm_config)
        if provider is not None:
            await provider.initialize()
            return provider
        logger.warning("synapse engine unavailable — falling back to composite")

    config = build_memory_provider_config(
        session_id=session_id,
        storage_path=storage_path,
        username=username,
        ltm_config=ltm_config,
    )
    # 2.2.0 — the embedding API key rides the CredentialBundle's
    # 'embedding' entry (single credential channel), not the config
    # dict / env ladder.
    factory = MemoryProviderFactory(credentials=_embedding_credentials(ltm_config))
    provider = factory.build(config)
    await provider.initialize()
    return provider


def _build_synapse_provider(*, session_id: str, storage_path: str, ltm_config: Any):
    """FileMemoryProvider whose vector layer is a local Synapse engine.

    Returns None (caller falls back to composite) if geny-memory-adaptor isn't
    installed. Zero embedding API calls: ``embedding_client=None`` and an
    injected ``vector_store`` bypass the file provider's embedding path."""
    try:
        import os

        from geny_memory_adaptor import SynapseConfig, SynapseMemory
        from geny_executor.memory.providers.file.provider import FileMemoryProvider

        from service.memory.synapse_handle import SynapseVectorHandle
        from service.memory.usage_tracker import MemoryUsageTracker
    except Exception:  # noqa: BLE001 — extra not installed / import error
        logger.warning("synapse: geny-memory-adaptor not available", exc_info=True)
        return None

    os.makedirs(storage_path, exist_ok=True)
    db_path = os.path.join(storage_path, "synapse.db")
    dim = int(getattr(ltm_config, "synapse_dim", 256) or 256)
    mem = SynapseMemory(SynapseConfig(
        path=db_path, dim=dim, store_text=True, store_text_maxlen=20_000))
    # The usage tracker closes the learning loop: search feeds it provenance,
    # the agent session flushes trusted signals into SynapseMemory.learn. Reach
    # it from the session as ``provider.vector().usage_tracker``.
    tracker = MemoryUsageTracker()
    handle = SynapseVectorHandle(mem, dim=dim, usage_tracker=tracker)
    return FileMemoryProvider(
        root=storage_path, session_id=session_id,
        vector_store=handle, embedding_client=None)


async def build_single_tenant_provider(
    *,
    root: str,
    scope_id: str,
    scope: str = "session",
    enable_embedding: bool = False,
    ltm_config: Optional[Any] = None,
):
    """Build and `initialize()` a single-tenant `MemoryProvider`.

    Unlike :func:`build_memory_provider`, this does *not* construct
    a composite layout — the returned provider is a plain
    file-backed delegate rooted at ``root``. Used by the multi-tenant
    helpers (``GlobalMemoryManager`` /  ``CuratedKnowledgeManager`` /
    ``UserOpsidianManager``) which operate outside the session
    lifecycle and need their own NotesHandle / IndexHandle / VectorHandle
    scoped to a fixed directory.

    Args:
        root: Absolute path to the tenant's memory directory.
        scope_id: Identifier the executor records on every BackendInfo
            descriptor — used as ``session_id`` for the underlying
            file provider so audit logs surface a recognisable origin
            (e.g., ``"global"`` / ``"curated:<user>"`` /
            ``"user:<user>"``).
        scope: ``"session"`` (default) or ``"user"``. Notes get this
            scope tag in their ``NoteRef``.
        enable_embedding: When True and ``ltm_config`` carries a valid
            embedding spec, the provider attaches the executor's
            embedding client so vector search works. When False, the
            provider stays markdown-only.
        ltm_config: Live :class:`LTMConfig`. Loaded from disk if not
            supplied. Only consulted when ``enable_embedding`` is set.

    Returns:
        A live `MemoryProvider`. Caller is responsible for
        ``await provider.close()`` at teardown.
    """
    from geny_executor.memory.factory import MemoryProviderFactory

    if enable_embedding and ltm_config is None:
        try:
            from service.config import get_config_manager
            from service.config.sub_config.general.ltm_config import LTMConfig

            mgr = get_config_manager()
            ltm_config = mgr.load_config(LTMConfig) or LTMConfig.get_default_instance()
        except Exception:  # noqa: BLE001
            logger.warning(
                "build_single_tenant_provider: failed to load LTMConfig; "
                "embedding disabled",
                exc_info=True,
            )
            ltm_config = None

    config: Dict[str, Any] = {
        "provider": "file",
        "root": str(root),
        "session_id": scope_id,
        "scope": scope,
    }
    credentials = None
    if enable_embedding and ltm_config is not None:
        embedding = _embedding_config(ltm_config)
        if embedding is not None:
            config["embedding"] = embedding
            # 2.2.0 — key travels in the bundle, not the config dict.
            credentials = _embedding_credentials(ltm_config)

    factory = MemoryProviderFactory(credentials=credentials)
    provider = factory.build(config)
    await provider.initialize()
    return provider


__all__ = [
    "build_memory_provider",
    "build_memory_provider_config",
    "build_single_tenant_provider",
]
