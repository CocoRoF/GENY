"""Unified memory-path LLM helper.

Builds a ``BaseClient`` + ``ModelConfig`` and wraps them in a small
``MemoryLLM`` adapter for offline memory-curation jobs that run
outside any session and therefore have no manifest to consult.

Provider resolution mirrors ``backend_resolver.pick_default_backend_provider``
— Claude Code CLI when the user has it enabled, otherwise whichever
API-key backend they configured. Credentials flow through the same
``CredentialBundleBuilder`` Geny uses to feed live sessions, so a
user logged into Claude Code via OAuth gets their memory curation
run on the same backend as their chat sessions — no separate
``ANTHROPIC_API_KEY`` requirement.
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
    """Build a memory-path LLM adapter for offline curation.

    Resolves the active backend via ``pick_default_backend_provider``
    and constructs the matching client through
    ``CredentialBundleBuilder`` — the same channel live sessions use,
    so a Claude-Code-CLI user has their memory curated through the CLI
    too, not silently routed to a stale Anthropic key.

    Returns ``None`` when no backend has usable credentials so callers
    (``CurationEngine`` already gates every LLM stage on ``self._llm``)
    degrade cleanly to rule-based paths.
    """
    try:
        from service.config.manager import get_config_manager
        from service.config.sub_config.general.api_config import APIConfig
        from service.executor.backend_resolver import pick_default_backend_provider
        from service.executor.credentials import CredentialBundleBuilder
        from geny_executor.core.pipeline import _creds_to_client_kwargs

        cm = get_config_manager()
        api_cfg = cm.load_config(APIConfig)
        provider = pick_default_backend_provider(cm)
        bundle = CredentialBundleBuilder(cm).build()
        creds = bundle.get(provider)
        if creds.is_empty():
            return None

        model_name = (api_cfg.memory_model or "").strip() or api_cfg.anthropic_model
        if not model_name:
            return None

        client_cls = ClientRegistry.get(provider)
        client = client_cls(**_creds_to_client_kwargs(provider, creds))

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
