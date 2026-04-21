"""Unified memory-path LLM helper.

Builds a ``BaseClient`` + ``ModelConfig`` from ``APIConfig`` and wraps
them in a small ``MemoryLLM`` adapter. Offline memory-path callers
(curation scheduler / controller) use this instead of instantiating
``ChatAnthropic`` directly so that ``APIConfig.provider`` and
``APIConfig.base_url`` are honoured — without this, a user who
switched the provider to ``openai`` or ``vllm`` would silently still
hit Anthropic for every curation note.

This module is the cycle ``20260421_5`` closure of the curation
migration explicitly deferred by ``20260421_4``
(see ``dev_docs/20260421_4/analysis/02_memory_llm_inventory.md``
§6 — "Sites NOT touched by this cycle").
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from logging import getLogger
from typing import Optional

from geny_executor.core.config import ModelConfig
from geny_executor.llm_client import BaseClient, ClientRegistry

logger = getLogger(__name__)


@dataclass
class MemoryLLM:
    """Thin adapter wrapping a ``BaseClient`` + preconfigured ``ModelConfig``.

    Exposes a single ``complete(prompt)`` coroutine so callers that
    previously spoke the LangChain ``Runnable.ainvoke([HumanMessage])``
    shape migrate with one line per call site. Returns the joined text
    content; callers that need the full ``APIResponse`` can reach
    through ``client`` + ``model_config`` directly.
    """

    client: BaseClient
    model_config: ModelConfig

    async def complete(
        self,
        prompt: str,
        *,
        system: str = "",
        purpose: str = "memory.curation",
    ) -> str:
        response = await self.client.create_message(
            model_config=self.model_config,
            messages=[{"role": "user", "content": prompt}],
            system=system,
            purpose=purpose,
        )
        return response.text


def build_memory_llm() -> Optional[MemoryLLM]:
    """Build a memory-path LLM adapter from the current ``APIConfig``.

    Returns ``None`` when no API key / model is configured so callers
    already prepared for a falsy value (``CurationEngine`` gates every
    LLM stage on ``self._llm``) degrade cleanly to rule-based paths.
    Empty ``memory_model`` falls back to ``anthropic_model`` — same
    semantics as ``AgentSession._build_pipeline``.
    """
    try:
        from service.config.manager import get_config_manager
        from service.config.sub_config.general.api_config import APIConfig

        api_cfg = get_config_manager().load_config(APIConfig)
        api_key = api_cfg.anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY", "")
        if not api_key:
            return None

        model_name = (api_cfg.memory_model or "").strip() or api_cfg.anthropic_model
        if not model_name:
            return None

        provider_name = (getattr(api_cfg, "provider", "") or "anthropic").strip()
        base_url = (getattr(api_cfg, "base_url", "") or "").strip() or None

        client_cls = ClientRegistry.get(provider_name)
        client_kwargs: dict = {"api_key": api_key}
        if base_url:
            client_kwargs["base_url"] = base_url
        client = client_cls(**client_kwargs)

        model_config = ModelConfig(
            model=model_name,
            max_tokens=2048,
            temperature=0.0,
            thinking_enabled=False,
        )
        return MemoryLLM(client=client, model_config=model_config)
    except Exception as exc:
        logger.warning("build_memory_llm failed: %s", exc)
        return None
