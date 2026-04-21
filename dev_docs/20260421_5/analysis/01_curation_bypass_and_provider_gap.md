# Analysis 01 — Curation bypass + provider/base_url gap

**Date.** 2026-04-21
**Scope.** Factual map of the one remaining memory-path LLM bypass
in the Geny backend after cycle 20260421_4 lands. Establishes why
cycle 20260421_4's deferral reasoning does not survive its own
landing.

## 1. What cycle 20260421_4 shipped (recap)

- ``geny_executor.llm_client`` — ``BaseClient`` + ``ClientRegistry``
  + per-vendor clients (anthropic / openai / google / vllm).
- ``state.llm_client`` — single handle any stage reaches for when it
  needs an LLM.
- ``PipelineMutator.set_stage_model(order, cfg)`` — per-stage model
  override installed from Geny for s02 (context compaction) and s15
  (reflection).
- ``AgentSession._build_pipeline`` — builds a ``BaseClient`` via
  ``ClientRegistry.get(api_cfg.provider)(api_key, base_url)`` and
  injects it via ``attach_runtime(llm_client=…)``.

Result: every LLM call made *inside a pipeline session* flows
through the unified client. Provider/base_url selection is honoured
end-to-end.

## 2. The one place it does not apply

``backend/service/memory/reflect_utils.py`` (pre-5, 41 lines):

```python
def get_memory_model():
    api_cfg = get_config_manager().load_config(APIConfig)
    api_key = api_cfg.anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY", "")
    mem_model = api_cfg.memory_model
    if not api_key or not mem_model:
        return None
    from langchain_anthropic import ChatAnthropic
    return ChatAnthropic(model=mem_model, api_key=api_key, max_tokens=2048, timeout=30)
```

Called from:

| Call site | File:line | Purpose |
|---|---|---|
| Curation scheduler | ``service/memory/curation_scheduler.py:125`` | Background batch curation every 5 min |
| `POST /curate` | ``controller/curated_knowledge_controller.py:281`` | On-demand single-note curation |
| `POST /curate/batch` | ``controller/curated_knowledge_controller.py:333`` | On-demand batch curation |
| `POST /curate/all` | ``controller/curated_knowledge_controller.py:397`` | On-demand full-vault curation |

Downstream, ``CurationEngine`` (``service/memory/curation_engine.py``)
uses the returned model via LangChain's ``Runnable.ainvoke([HumanMessage(…)])``
contract across three stages:

- ``_llm_analyze`` (L460) — quality assessment of incoming notes
- ``_transform`` (L519) — summary/extract/restructure/merge rewrites
- ``_enrich`` (L588) — tag + link suggestions

## 3. Observable defects

### 3.1 Provider switch is silently ignored

``APIConfig.provider`` and ``APIConfig.base_url`` are surfaced in the
settings UI (cycle-4 added the fields). When a user flips provider
to ``openai`` / ``vllm``:

- ``AgentSession._build_pipeline`` picks it up and the running
  session uses the new provider.
- ``get_memory_model()`` ignores it and keeps returning a
  ``ChatAnthropic`` — curation continues to dial Anthropic silently.
- If ``ANTHROPIC_API_KEY`` is empty but the OpenAI key is set, the
  curation engine receives ``None`` from ``get_memory_model`` and
  degrades to rule-based paths while the session works fine.

From the user's point of view: "why does the session use vLLM but
my nightly curation still gets charged against my Anthropic bill?"
This is a real invisible-behavior bug.

### 3.2 base_url override has no effect on curation

Same class of bug. A user running Anthropic against a proxy /
Bedrock passthrough sets ``LLM_BASE_URL``; the session honours it,
curation does not.

### 3.3 LangChain stays as a runtime dependency of the memory subtree

After cycle-4, the memory subtree has one live LangChain import:
``from langchain_anthropic import ChatAnthropic`` in
``reflect_utils.py`` + ``from langchain_core.messages import HumanMessage``
at three call sites in ``curation_engine.py``. Every other memory
path has migrated. Keeping one lonely LangChain anchor forces the
dependency to stay in ``pyproject.toml`` and leaves a fragmented
error-handling story (LangChain's exceptions vs. ``BaseClient``'s
``APIError``).

## 4. Why cycle-4's deferral no longer holds

Cycle-4 analysis §6 justified skipping this with:

> "adds lifecycle complexity (the curator runs on a schedule, not in
> a session) and has no routing problem (it already reads
> `APIConfig.memory_model`)"

**"Lifecycle complexity"** — the ``BaseClient`` shipped by cycle-4
is session-agnostic. Construction is:

```python
client_cls = ClientRegistry.get(provider_name)
client = client_cls(api_key=…, base_url=…)
```

No session, no pipeline, no attach_runtime required. The background
scheduler can build one at each fire. Lifecycle complexity is zero.

**"No routing problem"** — the premise was wrong. It does read
``memory_model``, but it hardcodes the *provider* as Anthropic. The
routing problem is exactly the gap between the model field (read)
and the provider/base_url fields (ignored).

## 5. Size of the migration

- One new module (``memory_llm.py``, ~70 lines incl. docstrings).
- Three ``await self._llm.complete(prompt, purpose=…)`` replacements
  in ``curation_engine.py`` (removing 9 lines of LangChain
  boilerplate per site).
- Four call-site imports updated (one per scheduler / three
  controllers) — mechanical.
- Delete one file (``reflect_utils.py``).
- One new test file (``test_memory_llm.py``) with 7 tests.

No executor changes, no pyproject bump, no release gate.
