"""GenyToolProvider — adapts Geny's ToolLoader as an AdhocToolProvider.

Implements the structural shape of
:class:`geny_executor.tools.providers.AdhocToolProvider` (``list_names()``
+ ``get(name)``) so ``Pipeline.from_manifest(adhoc_providers=[...])``
can consume it directly. No inheritance — the executor Protocol is
``@runtime_checkable`` and duck-typing keeps this module importable
even against executor versions that predate the Protocol.

**Active in env_id sessions.** Wired into
:meth:`EnvironmentService.instantiate_pipeline` by the Phase C
cutover PR; the env_id flow in ``AgentSessionManager`` constructs
one of these and forwards it as ``adhoc_providers=[...]`` so that
``manifest.tools.external`` names resolve against Geny's
:class:`~service.tool_loader.ToolLoader`. The non-env_id
``AgentSession._build_pipeline`` path still uses
:class:`~geny_executor.memory.GenyPresets` directly — replacing
that path requires a follow-on PR (manifest stage chain +
post-construction memory_manager / callback attach helper).

Usage::

    from service.executor.geny_tool_provider import GenyToolProvider
    provider = GenyToolProvider(tool_loader)
    pipeline = await Pipeline.from_manifest_async(
        manifest, api_key=api_key, adhoc_providers=[provider],
    )
"""

from __future__ import annotations

from logging import getLogger
from typing import Any, Dict, List, Optional

logger = getLogger(__name__)


class GenyToolProvider:
    """Surfaces Geny's :class:`~service.tool_loader.ToolLoader` through
    the executor's :class:`AdhocToolProvider` Protocol.

    :meth:`list_names` advertises every tool the loader knows about —
    both built-in (``tools/built_in``) and custom (``tools/custom``).
    The pipeline decides which of those get registered by consulting
    ``manifest.tools.external``; this provider never filters by preset
    itself, keeping responsibility clean.

    :meth:`get` returns the tool directly — Geny's ``BaseTool`` /
    ``ToolWrapper`` ARE ``geny_executor.tools.base.Tool`` subclasses now
    (they implement ``async execute(input, context)`` themselves), so no
    adapter is needed. The legacy ``_GenyToolAdapter`` is gone.
    """

    def __init__(
        self,
        tool_loader: Any,
        satisfied_config: Optional[set] = None,
    ) -> None:
        """Wrap *tool_loader*.

        Args:
            tool_loader: An already-loaded
                :class:`~service.tool_loader.ToolLoader` (has
                :meth:`get_tool` + :meth:`get_all_names` methods).
            satisfied_config: The env's satisfied config-token set (see
                :mod:`service.executor.tool_config_gate`). When provided, a tool
                whose ``REQUIRED_CONFIG`` tokens are not all satisfied is NOT
                supplied — it never registers and never reaches the engine
                (progressive disclosure). ``None`` disables gating (back-compat).
        """
        self._loader = tool_loader
        self._cache: Dict[str, Any] = {}
        self._satisfied = satisfied_config

    def _available(self, tool: Any) -> bool:
        from service.executor.tool_config_gate import tool_is_available

        return tool_is_available(tool, self._satisfied)

    def list_names(self) -> List[str]:
        """Names the loader can supply (built-in + custom), minus any tool gated
        out by unmet required config."""
        get_all = getattr(self._loader, "get_all_names", None)
        if get_all is not None:
            names = list(get_all())
        else:
            # Fallback for older ToolLoader shapes — keeps rollout robust.
            all_tools = getattr(self._loader, "get_all_tools", lambda: {})()
            names = list(all_tools.keys())
        if self._satisfied is None:
            return names
        out: List[str] = []
        for n in names:
            t = self._loader.get_tool(n)
            if t is not None and self._available(t):
                out.append(n)
        return out

    def get(self, name: str) -> Optional[Any]:
        """Return the executor :class:`Tool` for *name*, or ``None`` if the loader
        doesn't supply it OR its required config is unsatisfied (gated).

        Returning ``None`` for a gated tool makes geny-executor skip it during
        ``_register_external_tools`` — so an unconfigured tool is never registered
        and never advertised to the model. Geny tools are already ``Tool``
        instances, so this forwards the loader's tool directly. Only satisfied
        tools are cached.
        """
        if name in self._cache:
            return self._cache[name]

        base = self._loader.get_tool(name)
        if base is None:
            return None

        if not self._available(base):
            from service.executor.tool_config_gate import tool_required_config

            logger.info(
                "🚫 tool gated (unconfigured): %s needs %s — hidden from the agent",
                name, tool_required_config(base),
            )
            return None

        self._cache[name] = base
        return base
