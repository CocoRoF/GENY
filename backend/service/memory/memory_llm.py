"""Unified memory-path LLM helper.

Builds a ``BaseClient`` + ``ModelConfig`` and wraps them in a small
``MemoryLLM`` adapter for offline memory-curation jobs that run
outside any session and therefore have no manifest to consult.

Provider resolution uses the library-owned
``CredentialBundle.preferred_provider()`` (geny-executor 2.2.0) —
Claude Code CLI when the user has it enabled, otherwise whichever
API-key backend they configured. Credentials flow through the same
``CredentialBundleBuilder`` Geny uses to feed live sessions, so a
user logged into Claude Code via OAuth gets their memory curation
run on the same backend as their chat sessions — no separate
``ANTHROPIC_API_KEY`` requirement.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from logging import getLogger
from typing import Any, Dict, Optional

from geny_executor.core.config import ModelConfig
from geny_executor.llm_client import BaseClient, ClientRegistry

logger = getLogger(__name__)

try:  # geny-executor >= 2.46.0
    from geny_executor.memory import MEMORY_ENGINE_SYSTEM_PROMPT
except Exception:  # noqa: BLE001 — older executor
    MEMORY_ENGINE_SYSTEM_PROMPT = (
        "You are a memory maintenance engine inside an agent platform. You "
        "are NOT an assistant and you are NOT talking to a user. Produce "
        "only the requested artifact — no preamble, no questions."
    )


def _parse_json_text(text: str) -> Optional[Dict[str, Any]]:
    """Best-effort JSON object from a model reply (tolerates code fences)."""
    cleaned = (text or "").strip()
    if not cleaned:
        return None
    if cleaned.startswith("```"):
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start < 0 or end <= start:
            return None
        cleaned = cleaned[start : end + 1]
    try:
        data = json.loads(cleaned)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


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
        system: Optional[str] = None,
        purpose: str = "memory.curation",
    ) -> str:
        """Freeform completion. The engine system framing is applied by
        default — every memory-path call is maintenance work, and without
        it a CLI-backed model answers the archival material as an
        assistant (the root cause of chat replies persisted as memory).
        Pass ``system=""`` explicitly to opt out."""
        response = await self.client.create_message(
            model_config=self.model_config,
            messages=[{"role": "user", "content": prompt}],
            system=MEMORY_ENGINE_SYSTEM_PROMPT if system is None else system,
            purpose=purpose,
        )
        return response.text

    async def complete_structured(
        self,
        prompt: str,
        schema: Dict[str, Any],
        *,
        purpose: str = "memory.structured",
    ) -> Optional[Dict[str, Any]]:
        """Schema-bound completion → parsed dict, or ``None`` (callers keep
        previous state on None — never persist an unvalidated reply).

        Enforcement is native where the backend supports it (Claude Code
        CLI ``--json-schema`` → ``APIResponse.structured``); other
        backends carry the format as advisory and we parse+validate the
        text, with one corrective retry."""
        response_format = {"type": "json_schema", "json_schema": schema}
        messages = [{"role": "user", "content": prompt}]
        for attempt in (0, 1):
            try:
                response = await self.client.create_message(
                    model_config=self.model_config,
                    messages=messages,
                    system=MEMORY_ENGINE_SYSTEM_PROMPT,
                    purpose=purpose,
                    response_format=response_format,
                )
            except Exception:  # noqa: BLE001 — transport; caller keeps state
                logger.warning(
                    "memory_llm: structured call failed", exc_info=True,
                )
                return None
            structured = getattr(response, "structured", None)
            if isinstance(structured, dict):
                return structured
            parsed = _parse_json_text(response.text)
            if parsed is not None:
                return parsed
            if attempt == 0:
                messages = messages + [
                    {"role": "assistant", "content": response.text or ""},
                    {
                        "role": "user",
                        "content": (
                            "Invalid output. Return ONLY a JSON object "
                            "matching the provided schema — no prose, no "
                            "code fences."
                        ),
                    },
                ]
        logger.warning("memory_llm: structured output unparseable after retry")
        return None


def build_memory_llm() -> Optional[MemoryLLM]:
    """Build a memory-path LLM adapter for offline curation.

    Resolves the active backend via the library's
    ``CredentialBundle.preferred_provider()`` and constructs the
    matching client through ``CredentialBundleBuilder`` — the same
    channel live sessions use, so a Claude-Code-CLI user has their
    memory curated through the CLI too, not silently routed to a stale
    Anthropic key.

    Returns ``None`` when no backend has usable credentials so callers
    (``CurationEngine`` already gates every LLM stage on ``self._llm``)
    degrade cleanly to rule-based paths.
    """
    try:
        from service.config.manager import get_config_manager
        from service.config.sub_config.general.api_config import APIConfig
        from service.executor.credentials import CredentialBundleBuilder
        # NOTE: ``_creds_to_client_kwargs`` is still private in
        # geny-executor 2.2.0 — flagged upstream for promotion to a
        # public client factory in 2.2.x. Revisit this import when that
        # lands.
        from geny_executor.core.pipeline import _creds_to_client_kwargs

        cm = get_config_manager()
        api_cfg = cm.load_config(APIConfig)
        bundle = CredentialBundleBuilder(cm).build()
        provider = bundle.preferred_provider()
        if provider is None:
            return None
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
