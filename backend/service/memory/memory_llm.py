"""Unified memory-path LLM helper.

Builds a ``BaseClient`` + ``ModelConfig`` and wraps them in a small
``MemoryLLM`` adapter. Phase H — the memory path is hardcoded to the
Anthropic client because ``memory_model`` is always a Claude model
in defaults, and there is no longer a global "current provider"
setting (provider selection is per-Environment at the manifest
level). The API key comes from the hidden ``LLMCredentialsConfig``
(edited via the LLM Backends panel), and the model name from
``APIConfig.memory_model`` / ``anthropic_model``.

Offline memory-path callers (curation scheduler / controller) use
this instead of instantiating ``ChatAnthropic`` directly.
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
    """Build a memory-path LLM adapter.

    Hardcoded to the Anthropic client — see module docstring. Returns
    ``None`` when no API key / model is configured so callers already
    prepared for a falsy value (``CurationEngine`` gates every LLM
    stage on ``self._llm``) degrade cleanly to rule-based paths.
    Empty ``memory_model`` falls back to ``anthropic_model`` — same
    semantics as ``AgentSession._build_pipeline``.
    """
    try:
        from service.config.manager import get_config_manager
        from service.config.sub_config.general.api_config import APIConfig
        from service.config.sub_config.general.llm_credentials_config import (
            LLMCredentialsConfig,
        )

        cm = get_config_manager()
        api_cfg = cm.load_config(APIConfig)
        creds = cm.load_config(LLMCredentialsConfig)

        api_key = creds.anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY", "")
        if not api_key:
            return None

        model_name = (api_cfg.memory_model or "").strip() or api_cfg.anthropic_model
        if not model_name:
            return None

        client_cls = ClientRegistry.get("anthropic")
        client = client_cls(api_key=api_key)

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
