"""DynamicPersonaSystemBuilder — PromptBuilder that resolves per turn.

Replaces the fixed-block ``ComposablePromptBuilder`` attached to stage 3.
Every ``build(state)`` invocation:

1. Reads ``session_meta`` (frozen at builder construction; session-scoped).
2. Calls ``provider.resolve(state, session_meta=...)`` to get the current
   ``PersonaResolution``.
3. Composes a fresh ``ComposablePromptBuilder`` from the resolved persona
   blocks + the *static* tail blocks (DateTimeBlock, MemoryContextBlock, …).
4. Returns the composed output (string or content-block list) in the same
   shape ``ComposablePromptBuilder`` uses — ``SystemStage.execute`` accepts
   both.

The builder does not hold any persona state itself. All mutable inputs are
owned by the ``PersonaProvider`` implementation and are therefore visible
to later turns without rebuilding the pipeline.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Union

from geny_executor.core.state import PipelineState
from geny_executor.stages.s03_system.artifact.default.builders import (
    ComposablePromptBuilder,
)
from geny_executor.stages.s03_system.interface import PromptBlock, PromptBuilder

from service.persona.provider import PersonaProvider, PersonaResolution


class DynamicPersonaSystemBuilder(PromptBuilder):
    """PromptBuilder that calls a PersonaProvider on every build."""

    def __init__(
        self,
        provider: PersonaProvider,
        *,
        session_meta: Dict[str, Any],
        tail_blocks: Optional[List[PromptBlock]] = None,
        separator: str = "\n\n",
        use_content_blocks: bool = False,
    ):
        self._provider = provider
        self._session_meta = dict(session_meta)
        self._tail_blocks: List[PromptBlock] = list(tail_blocks or [])
        self._separator = separator
        self._use_content_blocks = use_content_blocks

    @property
    def name(self) -> str:
        return "dynamic_persona"

    @property
    def description(self) -> str:
        return "Per-turn persona resolution via PersonaProvider"

    def configure(self, config: Dict[str, Any]) -> None:
        return None

    def get_config(self) -> Dict[str, Any]:
        return {
            "session_meta_keys": sorted(self._session_meta.keys()),
            "tail_block_names": [b.name for b in self._tail_blocks],
        }

    @property
    def session_meta(self) -> Dict[str, Any]:
        return dict(self._session_meta)

    def _compose_inner(self, state: PipelineState) -> ComposablePromptBuilder:
        resolution: PersonaResolution = self._provider.resolve(
            state, session_meta=self._session_meta
        )

        blocks: List[PromptBlock] = []
        blocks.extend(resolution.persona_blocks)
        blocks.extend(self._tail_blocks)
        if resolution.system_tail:
            blocks.append(_TailTextBlock(resolution.system_tail))

        return ComposablePromptBuilder(
            blocks=blocks,
            separator=self._separator,
            use_content_blocks=self._use_content_blocks,
        )

    def build(self, state: PipelineState) -> Union[str, List[Dict[str, Any]]]:
        return self._compose_inner(state).build(state)

    def build_parts(self, state: PipelineState) -> Optional[List[Dict[str, Any]]]:
        """Stable/volatile prompt parts (executor >=2.50.0 TTFT split).

        Stage 3 calls this FIRST; delegating to the inner
        ``ComposablePromptBuilder.build_parts`` lets the executor pull
        the volatile tail (clock, retrieved memory, runtime persona
        tail) out of the cached prompt prefix. Persona resolution runs
        once per turn either way. Returns ``None`` on older executor
        pins (attribute missing) or in content-blocks mode — Stage 3
        then falls back to :meth:`build` unchanged.
        """
        if self._use_content_blocks:
            return None
        inner = self._compose_inner(state)
        parts_fn = getattr(inner, "build_parts", None)
        return parts_fn(state) if callable(parts_fn) else None


class _TailTextBlock(PromptBlock):
    """Inline wrapper for ``PersonaResolution.system_tail`` text."""

    def __init__(self, text: str):
        self._text = text

    @property
    def name(self) -> str:
        return "persona_tail"

    @property
    def volatile(self) -> bool:
        # Runtime-appended persona context (append_context / observation
        # digests) changes turn-to-turn — it must never sit inside the
        # cached prompt prefix (executor >=2.50.0 TTFT split).
        return True

    def render(self, state: PipelineState) -> str:
        return self._text
