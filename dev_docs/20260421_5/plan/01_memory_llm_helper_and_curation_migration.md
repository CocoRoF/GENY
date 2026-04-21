# Plan 01 — MemoryLLM helper + curation migration

**PR.** `feat/memory-curation-unified-client` (single PR, Geny-only).
**Depends on.** Cycle 20260421_4 (merged). No executor release bump.
**Blocks.** Nothing.

## 1. Target shape

Every memory-path LLM call in the Geny backend — session or offline —
goes through one interface:

```python
# offline (curation)
llm = build_memory_llm()          # None if no key; Optional[MemoryLLM]
if llm is not None:
    text = await llm.complete(prompt, purpose="memory.curation.analyze")
```

```python
# in-session (cycle-4, unchanged)
state.llm_client  # BaseClient injected by _build_pipeline
stage.resolve_model_config(state)  # ModelConfig from PipelineMutator.set_stage_model
```

Both call paths dial the same vendor client (``AnthropicClient``,
``OpenAIClient``, ``GoogleClient``, or ``VLLMClient``) on the same
``memory_model`` (with ``anthropic_model`` fallback), honouring the
same ``provider`` + ``base_url`` selection.

## 2. New module — ``service/memory/memory_llm.py``

```python
@dataclass
class MemoryLLM:
    client: BaseClient
    model_config: ModelConfig

    async def complete(self, prompt, *, system="", purpose="memory.curation") -> str:
        resp = await self.client.create_message(
            model_config=self.model_config,
            messages=[{"role": "user", "content": prompt}],
            system=system, purpose=purpose,
        )
        return resp.text

def build_memory_llm() -> Optional[MemoryLLM]:
    # Mirror _build_pipeline's APIConfig reads:
    #   api_key = anthropic_api_key or ANTHROPIC_API_KEY env
    #   model   = (memory_model or "").strip() or anthropic_model
    #   provider = (provider or "").strip() or "anthropic"
    #   base_url = (base_url or "").strip() or None
    # On any failure (missing key/model, unknown provider, import error)
    # log at WARNING and return None — CurationEngine is prepared.
```

Fallback rule mirrors cycle-4 exactly. No new knob, no new surprise.

## 3. Call-site migration

### 3.1 ``curation_engine.py`` — three in-line invocations

Before:

```python
from langchain_core.messages import HumanMessage
response = await self._llm.ainvoke([HumanMessage(content=prompt)])
text = response.content if hasattr(response, "content") else str(response)
```

After:

```python
text = await self._llm.complete(prompt, purpose="memory.curation.analyze")
```

(and ``memory.curation.transform.{method}`` / ``memory.curation.enrich``
for the other two sites — distinct ``purpose`` strings so a future
cost accumulator can split them).

Delete the three ``from langchain_core.messages import HumanMessage``
imports.

Constructor docstring grows a one-line note: "``llm_model`` is a
duck-typed ``MemoryLLM``". The parameter name stays ``llm_model`` for
churn minimisation — it's an opaque handle to callers.

### 3.2 Four callers

| File | Change |
|---|---|
| ``service/memory/curation_scheduler.py`` | Import ``build_memory_llm``, call it instead of ``_get_memory_model`` |
| ``controller/curated_knowledge_controller.py`` (3 endpoints) | Same; uses `replace_all` because the three endpoints share the identical import+call pair |

### 3.3 Delete ``service/memory/reflect_utils.py``

No remaining callers. No external import path — it was always
internal.

## 4. Tests

New file: ``backend/tests/service/memory/test_memory_llm.py``.

- ``test_build_memory_llm_returns_none_without_api_key``
- ``test_build_memory_llm_uses_memory_model_when_set``
- ``test_build_memory_llm_falls_back_to_main_model_when_memory_empty``
- ``test_build_memory_llm_uses_provider_selection``
- ``test_build_memory_llm_passes_base_url``
- ``test_build_memory_llm_unknown_provider_returns_none``
- ``test_memory_llm_complete_returns_response_text`` (MagicMock client;
  asserts the ``messages``, ``model_config``, ``purpose`` flow through
  to ``BaseClient.create_message`` correctly).

Config-manager singleton reset fixture mirrors the pattern
established by ``test_memory_model_routing.py`` (cycle-4) — same
``monkeypatch.setattr(mgr_mod, "_config_manager", None)`` +
``tmp_path`` ConfigManager redirect. Without it, env-var changes
from one test poison the next.

No changes needed to existing ``CurationEngine`` tests — the contract
``self._llm`` is an async-duck-typed ``.complete(prompt)`` speaker
holds regardless of whether that duck is LangChain's ``ChatAnthropic``
or ``MemoryLLM``. Current ``CurationEngine`` tests use ``llm_model=None``
and already verify the rule-based fallback path, unchanged by this PR.

## 5. Plan deviations (anticipated)

None. The migration is narrow, the interfaces are already stable
from cycle-4, and the tests use the same singleton-reset pattern
already proven in cycle-4.

## 6. Risk table

| Risk | Likelihood | Mitigation |
|---|---|---|
| ``MemoryLLM`` return type drift breaks ``CurationEngine`` | Low | Contract is ``async def complete(prompt, *, purpose) -> str``; unit test pins it |
| Curation runs silently without LLM after deploy (no key) | Low | Same as today — ``get_memory_model()`` also returned ``None`` in that case |
| ``ClientRegistry.get(unknown_provider)`` raises, kills curation | Low | ``build_memory_llm`` catches and logs at WARNING → returns None → rule-based fallback |
| LangChain removal breaks unrelated code | **None** | Grep confirms ``langchain_anthropic`` / ``HumanMessage`` not used elsewhere in ``backend/service`` (post-cycle-4) |

## 7. Rollout

1. Merge this PR.
2. On next deploy, set ``LLM_PROVIDER=openai`` (or leave Anthropic) —
   curation follows the session.
3. If a regression appears (unlikely), revert is a single commit —
   ``get_memory_model`` can be resurrected from git history; the
   call-site diff is symmetric.

## 8. Acceptance

- [x] ``build_memory_llm`` returns None on missing key.
- [x] Empty ``memory_model`` falls back to ``anthropic_model``.
- [x] Provider/base_url flow through to ``BaseClient``.
- [x] ``CurationEngine`` three sites call ``await self._llm.complete(…)``
      with distinct ``purpose`` strings.
- [x] ``from langchain_core.messages`` gone from memory subtree.
- [x] ``reflect_utils.py`` deleted.
- [x] 7 new unit tests covering the adapter + the factory.
- [x] No executor bump (no cross-repo dependency).
