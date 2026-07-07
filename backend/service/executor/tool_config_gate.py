"""Config-gating for tools — the unconfigured-tool-hiding (progressive disclosure)
mechanism (Phase 0 of the built-in tool expansion).

A tool declares the config it needs via a ``REQUIRED_CONFIG`` class/instance attr
(a tuple of opaque tokens). At session build time Geny computes the set of
**satisfied** tokens for the environment; :class:`GenyToolProvider` then refuses to
supply any tool whose required tokens are not all satisfied — so the tool is never
registered into the pipeline, never appears in ``state.tools``, and never reaches
geny-executor's Agent engine. A tool with no ``REQUIRED_CONFIG`` is always
available (back-compat).

Token convention (Geny owns the policy; the executor only sees "provider returned
None"):
  - ``"config:<name>"``   — global :class:`BaseConfig` ``<name>`` is valid AND
                            enabled (configs without an ``enabled`` field count as
                            enabled).
  - ``"setting:<key>"``   — the per-env :class:`ToolSettingSchema` ``<key>``'s
                            ``required`` fields are all set for THIS environment.
  - ``"feature:<flag>"``  — a named feature flag is on (special-cased below).

This is also the structural hook for future native integrations (Google, Notion,
…) and for gating MCP connectors: a tool/connector just declares its tokens.
"""

from __future__ import annotations

from logging import getLogger
from typing import Any, Optional, Set, Tuple

logger = getLogger(__name__)


def tool_required_config(tool: Any) -> Tuple[str, ...]:
    """The config tokens a tool requires (empty = always available)."""
    raw = getattr(tool, "REQUIRED_CONFIG", ()) or ()
    try:
        return tuple(str(x) for x in raw)
    except Exception:  # noqa: BLE001
        return ()


def tool_is_available(tool: Any, satisfied: Optional[Set[str]]) -> bool:
    """True if every token the tool requires is satisfied. ``satisfied=None``
    disables gating entirely (back-compat)."""
    if satisfied is None:
        return True
    return all(tok in satisfied for tok in tool_required_config(tool))


def compute_satisfied_config(env_tool_settings: Optional[dict] = None) -> Set[str]:
    """Compute the satisfied-config token set for an environment.

    *env_tool_settings* is the env's ``host_selections.extras.tool_settings`` map
    (key → field values). Global config + feature flags + GAPT connectivity are
    read from the host singletons."""
    satisfied: Set[str] = set()

    # 1) Global BaseConfig: valid + enabled → config:<name>
    try:
        from service.config import get_config_manager

        mgr = get_config_manager()
        for name, cls in mgr.get_registered_config_classes().items():
            try:
                cfg = mgr.load_config(cls)
                if not cfg.is_valid():
                    continue
                if getattr(cfg, "enabled", True):
                    satisfied.add(f"config:{name}")
            except Exception:  # noqa: BLE001 — one bad config must not break gating
                continue
    except Exception:  # noqa: BLE001
        pass

    # 2) Feature flags (special-cased — not a uniform BaseConfig field)
    try:
        from service.config import get_config_manager
        from service.config.sub_config.general.ltm_config import LTMConfig

        ltm = get_config_manager().load_config(LTMConfig)
        if getattr(ltm, "curated_knowledge_enabled", False):
            satisfied.add("feature:curated_knowledge")
        # The knowledge REPOSITORY (documents the user explicitly uploaded
        # for the agent) is operational whenever LTM is on — its read/
        # search/fetch tools gate on this, INDEPENDENT of the
        # user_opsidian raw-access flags (which govern free access to ALL
        # personal notes, a privacy control, not agent-facing uploads).
        if getattr(ltm, "enabled", False):
            satisfied.add("feature:knowledge_repository")
        # Raw access to the FULL personal vault (browse every note) still
        # respects the index flag.
        if getattr(ltm, "user_opsidian_index_enabled", True):
            satisfied.add("feature:user_opsidian")
    except Exception:  # noqa: BLE001
        pass

    # 3) Per-env tool settings: all required fields set → setting:<key>
    try:
        from service.tool_settings.base import get_tool_setting_registry

        ts = env_tool_settings or {}
        for key, cls in get_tool_setting_registry().items():
            try:
                req = [f.name for f in cls.get_fields() if getattr(f, "required", False)]
                vals = ts.get(key) or {}
                if all(vals.get(fn) not in (None, "") for fn in req):
                    satisfied.add(f"setting:{key}")
            except Exception:  # noqa: BLE001
                continue
    except Exception:  # noqa: BLE001
        pass

    # 4) GAPT connectivity + per-tool gating.
    #
    # When GAPT is configured, the gapt_* tools are individually gated by
    # ``gapt_tool:<name>`` tokens driven by :class:`GaptToolsConfig` (all tools
    # default to enabled). Fail-OPEN: if the config can't be loaded for any
    # reason (or every tool is enabled), emit ALL gapt_tool:* tokens so a config
    # glitch never silently hides every GAPT tool. Only a subset is emitted when
    # the user has explicitly turned some tools off.
    try:
        from service.gapt import get_gapt_client

        if get_gapt_client().configured:
            satisfied.add("config:gapt")

            from service.config import get_config_manager
            from service.config.sub_config.tools.gapt_tools_config import (
                GaptToolsConfig,
            )

            tool_names = [f.name for f in GaptToolsConfig.get_fields_metadata()]
            try:
                cfg = get_config_manager().load_config(GaptToolsConfig)
                enabled = [n for n in tool_names if getattr(cfg, n, True)]
            except Exception:  # noqa: BLE001 — config load failed → fail OPEN
                enabled = list(tool_names)
            # Defensive: if nothing resolved as enabled (shouldn't happen given
            # defaults), fall open to all so we never hide the whole toolset.
            for name in (enabled or tool_names):
                satisfied.add(f"gapt_tool:{name}")
    except Exception:  # noqa: BLE001
        pass

    # 5) Google Workspace connected (OAuth refresh token present) → unlocks the
    # native google_* executor tools.
    try:
        from service.google import is_connected as _google_connected

        if _google_connected():
            satisfied.add("feature:google_connected")
    except Exception:  # noqa: BLE001
        pass

    return satisfied


__all__ = [
    "tool_required_config",
    "tool_is_available",
    "compute_satisfied_config",
]
