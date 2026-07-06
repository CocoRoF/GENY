"""Memory-engine LLM discipline (2026-07): every offline memory call is an
engine call — system-framed, and structured where a schema exists.

Root cause locked down: `complete()` used to send bare user messages with
`system=""` through the Claude-Code-CLI backend, which answered the archival
material as an assistant — those replies were persisted verbatim as the
rolling digest / daily digest / evergreen. Now the engine framing is the
default, and schema-bound calls return parsed dicts or None (callers keep
previous state on None).
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

import pytest

from geny_executor.core.config import ModelConfig

from service.memory.memory_llm import MemoryLLM, _parse_json_text


class _FakeResponse:
    def __init__(self, text: str = "", structured: Any = None):
        self.text = text
        self.structured = structured


class _FakeClient:
    def __init__(self, responses: List[_FakeResponse]):
        self._responses = list(responses)
        self.calls: List[Dict[str, Any]] = []

    async def create_message(self, **kwargs):
        self.calls.append(kwargs)
        return self._responses.pop(0)


def _llm(responses: List[_FakeResponse]) -> MemoryLLM:
    return MemoryLLM(
        client=_FakeClient(responses),  # type: ignore[arg-type]
        model_config=ModelConfig(model="m", max_tokens=64),
    )


_SCHEMA = {"type": "object", "required": ["x"], "properties": {"x": {"type": "string"}}}


@pytest.mark.asyncio
async def test_complete_applies_engine_system_by_default():
    llm = _llm([_FakeResponse(text="digest")])
    out = await llm.complete("summarize this")
    assert out == "digest"
    system = llm.client.calls[0]["system"]  # type: ignore[attr-defined]
    assert "NOT an assistant" in system


@pytest.mark.asyncio
async def test_complete_explicit_system_opt_out():
    llm = _llm([_FakeResponse(text="ok")])
    await llm.complete("p", system="")
    assert llm.client.calls[0]["system"] == ""  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_structured_prefers_native_envelope():
    llm = _llm([_FakeResponse(text="chatty wrap-up", structured={"x": "1"})])
    out = await llm.complete_structured("p", _SCHEMA)
    assert out == {"x": "1"}
    call = llm.client.calls[0]  # type: ignore[attr-defined]
    assert call["response_format"]["type"] == "json_schema"
    assert call["response_format"]["json_schema"] is _SCHEMA
    assert "NOT an assistant" in call["system"]


@pytest.mark.asyncio
async def test_structured_falls_back_to_text_parse():
    llm = _llm([_FakeResponse(text='```json\n{"x": "2"}\n```')])
    assert await llm.complete_structured("p", _SCHEMA) == {"x": "2"}


@pytest.mark.asyncio
async def test_structured_retries_once_then_none():
    llm = _llm([
        _FakeResponse(text="I'd be happy to help! What would you like?"),
        _FakeResponse(text="still not json"),
    ])
    assert await llm.complete_structured("p", _SCHEMA) is None
    calls = llm.client.calls  # type: ignore[attr-defined]
    assert len(calls) == 2
    # The corrective retry carries the invalid reply + the instruction.
    retry_messages = calls[1]["messages"]
    assert retry_messages[-1]["role"] == "user"
    assert "ONLY a JSON object" in retry_messages[-1]["content"]


def test_parse_json_text_variants():
    assert _parse_json_text('{"a": 1}') == {"a": 1}
    assert _parse_json_text('```json\n{"a": 1}\n```') == {"a": 1}
    assert _parse_json_text("nope") is None
    assert _parse_json_text("[1,2]") is None  # object required
    assert _parse_json_text("") is None
