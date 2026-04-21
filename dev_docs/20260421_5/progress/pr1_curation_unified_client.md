# PR-1 progress — curation through unified LLM client

- Branch: `feat/memory-curation-unified-client`
- Plan: `dev_docs/20260421_5/plan/01_memory_llm_helper_and_curation_migration.md`
- Depends on: cycle 20260421_4 (merged). No executor bump.
- Blocking: nothing — this closes cycle 20260421_5.

## What shipped

The curation memory-LLM path now routes through the cycle-4
``BaseClient`` / ``ClientRegistry``, honouring ``APIConfig.provider``
and ``APIConfig.base_url`` just like the session flow does.

### New — ``backend/service/memory/memory_llm.py``

``MemoryLLM`` dataclass wrapping a ``BaseClient`` + a pre-built
``ModelConfig``. Exposes ``async complete(prompt, *, system, purpose) -> str``.
``build_memory_llm()`` factory reads ``APIConfig`` with the same
fallback rule the pipeline uses (``memory_model`` → ``anthropic_model``),
chooses the provider via ``ClientRegistry.get``, and returns ``None``
on any failure so ``CurationEngine`` degrades to rule-based paths.

### Refactored — ``backend/service/memory/curation_engine.py``

Three in-line LLM invocations — ``_llm_analyze``, ``_transform``,
``_enrich`` — replaced their LangChain
``ainvoke([HumanMessage(content=prompt)])`` + ``.content`` unwrap with
``await self._llm.complete(prompt, purpose=…)``. Each site gets a
distinct ``purpose`` string (``memory.curation.analyze``,
``memory.curation.transform.{method}``, ``memory.curation.enrich``)
so a future cost accumulator can split them.

Three ``from langchain_core.messages import HumanMessage`` imports
removed. LangChain is no longer imported anywhere in the memory
subtree. Constructor docstring grows a one-line note describing the
new duck-typed expectation.

### Updated — four callers

- ``service/memory/curation_scheduler.py``
- ``controller/curated_knowledge_controller.py`` — three endpoints
  (``/curate``, ``/curate/batch``, ``/curate/all``)

All switched from ``from service.memory.reflect_utils import
get_memory_model`` to ``from service.memory.memory_llm import
build_memory_llm``.

### Deleted — ``backend/service/memory/reflect_utils.py``

Single-purpose helper with zero remaining callers.

## Tests

New: ``backend/tests/service/memory/test_memory_llm.py`` (7 tests):

| Test | Pins |
|------|------|
| `test_build_memory_llm_returns_none_without_api_key` | No key → adapter is None, curation degrades cleanly |
| `test_build_memory_llm_uses_memory_model_when_set` | `MEMORY_MODEL=haiku` propagates to `ModelConfig.model` + cycle-4 defaults (2048/0.0/no-thinking) |
| `test_build_memory_llm_falls_back_to_main_model_when_memory_empty` | Empty `MEMORY_MODEL` → `ANTHROPIC_MODEL` wins; matches `_build_pipeline` semantics |
| `test_build_memory_llm_uses_provider_selection` | `LLM_PROVIDER` drives `ClientRegistry.get` — correct client class is built |
| `test_build_memory_llm_passes_base_url` | `LLM_BASE_URL` lands on `client._base_url` — custom endpoints work |
| `test_build_memory_llm_unknown_provider_returns_none` | Bogus provider does NOT crash the scheduler — returns None |
| `test_memory_llm_complete_returns_response_text` | `MemoryLLM.complete` wraps `create_message` correctly: `messages`/`model_config`/`purpose` all passed through |

Config-manager singleton + tmp_path redirect fixture mirrors the
pattern from ``test_memory_model_routing.py`` (cycle-4).

## Plan deviations

None.

## Rollout

1. Merge this PR.
2. No executor release required.
3. On next deploy, users on non-Anthropic providers see curation
   dial the correct endpoint for the first time.

## Acceptance checks

- [x] ``build_memory_llm`` returns None on missing key.
- [x] Empty ``memory_model`` falls back to ``anthropic_model``.
- [x] Provider / base_url flow through to ``BaseClient``.
- [x] ``CurationEngine`` three sites call ``await self._llm.complete(…)``
      with distinct ``purpose`` strings.
- [x] ``from langchain_core.messages`` gone from memory subtree.
- [x] ``reflect_utils.py`` deleted.
- [x] 7 new unit tests covering the adapter + the factory.
- [x] No executor bump.
