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
    """
    if not getattr(ltm_config, "enabled", False):
        return None

    provider = (getattr(ltm_config, "embedding_provider", "") or "").strip()
    model = (getattr(ltm_config, "embedding_model", "") or "").strip()
    if not provider or not model:
        return None

    api_key = (getattr(ltm_config, "embedding_api_key", "") or "").strip()
    if not api_key:
        # Provider-specific env fallbacks. The executor's embedding
        # clients also fall back to env if api_key is empty, but we
        # surface it here too so the LTM-disabled path can still log a
        # clear "no key configured" diagnostic.
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

    return {"provider": provider, "model": model, "api_key": api_key}


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

    config = build_memory_provider_config(
        session_id=session_id,
        storage_path=storage_path,
        username=username,
        ltm_config=ltm_config,
    )
    factory = MemoryProviderFactory()
    provider = factory.build(config)
    await provider.initialize()
    return provider


__all__ = [
    "build_memory_provider",
    "build_memory_provider_config",
]
