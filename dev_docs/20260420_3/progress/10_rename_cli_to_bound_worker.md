# Progress 10 — `cli_*` → `bound_worker_*` rename

| Field | Value |
|-------|-------|
| Plan ref | `plan/03_vtuber_worker_binding.md` → **PR A** |
| Master ref | `plan/00_overview.md` → **Phase 3 / PR 18** |
| Geny PR | [#160](https://github.com/CocoRoF/Geny/pull/160) |
| Geny merge commit | `532a3da` on `main` |
| Status | **Merged** |

---

## Why this is Phase 3's entry PR

The Geny philosophy, stated by the user:

> VTuber는 대화를 위한 경량적 ENVIRONMENT고, 나머지는 WORKER로 제대로
> 된 업무 수행을 위한 것이야. VTUBER는 이러한 Worker를 하나씩 자신과
> BIND하여 가지고 있고, 그것을 활용할 수 있는 능력이 있는 것이 우리
> GENY의 기본 철학이야.

Translation: **VTuber is the persona layer; Worker is the
execution layer; a VTuber binds a Worker.**

The code still called the Worker side "CLI" — inherited from an
even earlier iteration where the worker spawned a Claude CLI
subprocess. That terminology has been wrong for two cycles:

1. The 20260420_1 cycle replaced the subprocess with in-process
   LangGraph — no CLI anywhere.
2. The 20260420_2 cycle replaced LangGraph with geny-executor
   Pipelines — still no CLI.

Phase 3's whole job is to bring naming and documentation in line
with the philosophy. This PR is the first step: rename the
schema. Everything downstream (auto-pair reshape, VTuber prompt
rewrite, BoundWorker contract doc) builds on this.

## Schema delta (`backend/service/claude_manager/models.py`)

| Before | After | Notes |
|--------|-------|-------|
| `cli_system_prompt` | `bound_worker_system_prompt` | Rename |
| `cli_model` | `bound_worker_model` | Rename |
| `cli_workflow_id` | **deleted** | Obsoleted by plan/02 — envs own stage layout |
| `cli_graph_name` | **deleted** | Same |
| `cli_tool_preset_id` | **deleted** | `manifest.tools` covers this declaratively (PR 11) |
| *(new)* | `bound_worker_env_id` | Explicit env override; None → `resolve_env_id(WORKER)` picks `template-worker-env` |

`session_type` description: `"vtuber"` / `"bound"` / `"solo"` or
None (was `"vtuber"` / `"cli"` / None).

### Why deleting three fields is safe

The deleted trio — `cli_workflow_id`, `cli_graph_name`,
`cli_tool_preset_id` — allowed callers to override the bound
Worker's workflow graph and tool preset from the VTuber creation
request. Under plan/02's manifest architecture:

- `workflow_id` / `graph_name` are gone at the parent layer too.
  Every session now resolves through `env_id → manifest`. A
  per-session workflow override made sense when workflows were
  the primary configuration artifact; they aren't anymore.
- `tool_preset_id` exists at the parent layer still, but the
  bound Worker no longer takes a preset — the Worker env's
  manifest declares `tools.built_in` and `tools.external`. If a
  VTuber wants a non-default Worker toolset, the correct lever
  is `bound_worker_env_id` pointing at a custom Worker env.

So the schema shrinks by 3 fields and gains 1 that is more
powerful than all three it replaces.

## Call-site updates

### `backend/service/langgraph/agent_session_manager.py`

The VTuber auto-pair block (lines 597-612) reads
`request.bound_worker_*` and writes `session_type="bound"`. The
three deleted overrides are replaced with the prior fallback
literals inline:

```python
workflow_id="template-optimized-autonomous",  # was: request.cli_workflow_id or …
graph_name="Optimized Autonomous",            # was: request.cli_graph_name or …
tool_preset_id=None,                          # was: request.cli_tool_preset_id
```

Plan PR 20 will reshape this whole block to use
`env_id=request.bound_worker_env_id` (letting the env resolver
pick defaults) and drop the `workflow_id` / `graph_name` /
`tool_preset_id` triple entirely. For now, preserving the
literal behavior keeps PR 18 a pure rename.

### `session_type == "cli"` → `== "bound"`

Six read-sites flipped atomically with the write-site:

| File | Line (pre-PR) | Context |
|------|---------------|---------|
| `agent_session.py` | 203 (comment) | `_session_type` type-hint comment |
| `agent_session.py` | 353 | `_is_always_warm` check |
| `agent_session_manager.py` | 281 | prompt context injection check |
| `agent_session_manager.py` | 610 | write-site: `session_type="cli"` → `"bound"` |
| `agent_executor.py` | 155 | bound-Worker autotrigger notify gate |
| `agent_executor.py` | 247 | Live2D model activity ping gate |

Split across three files, so an atomic rename is the only safe
approach — leaving any one of them stale would cause the
tightly-coupled VTuber↔Worker pair to silently drift.

### Frontend

- `frontend/src/types/index.ts`: interface updated to match.
- `frontend/src/components/modals/CreateSessionModal.tsx`:
  `formState.bound_worker_system_prompt` / `bound_worker_model`
  are the new read/write targets. The `payload.cli_tool_preset_id`
  write site is gone (the field no longer exists).

The modal still has a "CLI Agent Tool Preset" UI selector that
writes to `selectedCliPreset` React state. That state is now a
dead control — the `handleSubmit` path no longer transmits it.
I kept the JSX in place because removing it is pure UX cleanup
that belongs in PR 20's auto-pair reshape (which will decide
whether to replace the selector with a `bound_worker_env_id`
dropdown or delete it entirely).

## Explicitly out of scope

Plan/03 organizes the binding work into four PRs. This doc
covers only PR A.

- **Prompt injection strings** ("Paired CLI Agent" → "Bound
  Worker Agent" in the VTuber prompt; "Paired VTuber Agent" →
  "Paired VTuber Agent" in the Worker prompt, which already
  reads correctly). Plan PR B (master PR 20) owns these
  alongside the recursion-guard tightening.
- **UI label translation keys** (`cliPromptLabel`, `cliModel`,
  `cliToolPreset`, the Korean counterparts). These are user-
  visible strings, not schema. Deferred — they'll get rewritten
  when plan PR 22 updates `prompts/vtuber.md` and all related
  user-facing copy.
- **React state var names** (`selectedCliPrompt`,
  `handleCliPromptChange`, `cliPrompts` filter). Presentation-
  only, no protocol impact. Plan PR 20 will touch these while
  reshaping the modal.
- **`InfoTab.tsx`** uses `cliPromptDraft` / `cliData` state
  internally — those are display-only, no schema reference, so
  unchanged.

## Smoke test

Written as `/tmp/test_pr18_rename.py` (not checked in). 6 groups,
all passing:

| Group | Checks |
|:-----:|:-------|
| A | `models.py` declares three `bound_worker_*` fields and no `cli_*` fields |
| B | `agent_session_manager.py` reads `request.bound_worker_*`, writes `session_type="bound"`, no stale `request.cli_*` references |
| C | No `session_type == "cli"` literal survives in `agent_session.py`, `agent_session_manager.py`, or `agent_executor.py` |
| D | Frontend `types/index.ts` declares `bound_worker_*` and drops all `cli_*` |
| E | `CreateSessionModal.tsx` form state reads/writes are wired to `bound_worker_*`; no `cli_*` formState or payload writes remain |
| F | Pydantic round-trip: `CreateSessionRequest(bound_worker_model=…)` preserves the new fields in `model_dump()`, and the dump contains no `cli_*` keys |

PR 17's attach-runtime smoke test was re-run against the rename —
all 5 groups still pass (no regressions in the pipeline build
path).

## Manual verification

- [ ] Create a VTuber session through the UI. Confirm the auto-
      created bound Worker has `session_type == "bound"` in the
      session list / admin inspector.
- [ ] Confirm the bound Worker's system prompt still contains the
      "Paired VTuber Agent" block pointing back at the VTuber
      session_id. (Text unchanged in this PR — just verify the
      renamed `session_type == "bound"` check at line 281 still
      triggers the injection.)
- [ ] Confirm the Live2D model activity ping and the bound-Worker
      autotrigger notification both still fire for bound Workers
      (the two `_session_type == 'bound'` checks in
      `agent_executor.py`).

## Phase 3 status

| # | Title | PR | Status |
|---|-------|----|--------|
| 18 | Geny: rename `cli_*` → `bound_worker_*` in `CreateSessionRequest` | #160 | **Done** |
| 19 | Progress doc for PR 18 | *this doc* | Done |
| 20 | Geny: reshape VTuber auto-pair block (env_id resolution, recursion guard, prompt text) | — | Next |
| 21 | Progress doc for PR 20 | — | Pending |
| 22 | Geny: rewrite `prompts/vtuber.md` delegation paragraph | — | Pending |
| 23 | Progress doc for PR 22 | — | Pending |
| 24 | Geny: document BoundWorker contract in `backend/docs/` | — | Pending |
| 25 | Progress doc for PR 24 | — | Pending |

## Next

Master-plan PR 20 — the load-bearing Phase 3 PR. Reshape the
VTuber auto-pair block in `agent_session_manager.py`:

- Replace the hardcoded
  `workflow_id="template-optimized-autonomous"` /
  `graph_name="Optimized Autonomous"` / `tool_preset_id=None`
  triple with `env_id=request.bound_worker_env_id` so the role
  resolver picks `template-worker-env` by default.
- Add an explicit `session_type == "bound"` recursion guard
  (replacing today's implicit `not request.linked_session_id`
  check).
- Rewrite the prompt injection from "Paired CLI Agent" to
  "Bound Worker Agent" with wording that reflects the binding
  contract.
