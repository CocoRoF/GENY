# Cycle 20260421_5 — Route memory curation through the unified LLM client

**Date.** 2026-04-21
**Scope.** Geny backend only. No executor changes, no frontend work.
**Trigger.** Post-cycle audit of 20260421_4 surfaced one remaining
memory-path bypass: ``service/memory/reflect_utils.py`` still
instantiated ``langchain_anthropic.ChatAnthropic`` directly for the
offline curation scheduler / controllers. That path:

- Ignored ``APIConfig.provider`` — a user who selected ``openai`` or
  ``vllm`` silently still hit Anthropic for every curation note.
- Ignored ``APIConfig.base_url`` — custom endpoints had no effect on
  curation.
- Retained the only live LangChain runtime dependency in the memory
  subtree, anchoring a coupling 20260421_4 spent six PRs removing
  everywhere else.

Cycle 20260421_4's
[analysis/02_memory_llm_inventory.md](../20260421_4/analysis/02_memory_llm_inventory.md)
§6 explicitly deferred this ("Site 2 and Sites 8–10 — curation
batch path keeps its own ``ChatAnthropic``"). The stated rationale
— "adds lifecycle complexity (the curator runs on a schedule, not
in a session)" — does not hold up under the cycle-4 landing: the
unified ``BaseClient`` is session-agnostic and can be built
anywhere. Lifecycle complexity is zero.

## What changes

- **New.** ``backend/service/memory/memory_llm.py`` — a
  ``MemoryLLM`` adapter wrapping ``BaseClient`` +
  ``ModelConfig(model=memory_model or anthropic_model, …)``. Exposes
  ``async complete(prompt) -> str``. Built via ``build_memory_llm()``
  which reads ``APIConfig`` the same way ``AgentSession._build_pipeline``
  does — one fallback rule for the whole codebase.
- **Refactored.** ``CurationEngine._llm_analyze`` / ``_transform`` /
  ``_enrich`` switch from
  ``self._llm.ainvoke([HumanMessage(content=prompt)])`` to
  ``await self._llm.complete(prompt, purpose=…)``. LangChain
  ``HumanMessage`` imports disappear from the memory subtree.
- **Updated.** ``CurationScheduler`` + ``curated_knowledge_controller``
  (three endpoints) call ``build_memory_llm()`` instead of
  ``get_memory_model()``.
- **Deleted.** ``backend/service/memory/reflect_utils.py`` —
  single-purpose helper with no remaining callers.

## Out

- Unifying this with a cost/accounting accumulator (cycle-4 risk
  table line 1). Still a follow-up; ``purpose`` strings are tagged
  so a future cycle can route them.
- Executor changes. Everything here is above the executor's public
  interface; no release bump required.
- Frontend — no UI surface changes.

## PR plan

| PR | Branch | Scope |
|---|---|---|
| PR-1 | `feat/memory-curation-unified-client` | All of the above in a single PR. Small, self-contained, no cross-repo dependency. |

## Documents

- [analysis/01_curation_bypass_and_provider_gap.md](analysis/01_curation_bypass_and_provider_gap.md) — the exact bypass surface, why the cycle-4 deferral no longer holds
- [plan/01_memory_llm_helper_and_curation_migration.md](plan/01_memory_llm_helper_and_curation_migration.md) — design of ``MemoryLLM`` + call-site migration plan
- progress/ — populated as PRs land

## Relation to other cycles

- **20260421_4.** Closes the single deferred item from its
  analysis §6. After this cycle, zero active memory-path code in
  the Geny backend instantiates a vendor SDK directly.
- **E1 (executor uniformity).** Extends the "one client interface,
  many vendors" thesis from the pipeline into offline batch
  memory work.
