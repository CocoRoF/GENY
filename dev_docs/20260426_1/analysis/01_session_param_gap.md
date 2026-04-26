# 01 — Session parameter enforcement gap

**Date:** 2026-04-26
**Severity:** HIGH (UI deceives user — config has no effect)
**Trigger:** Post-D4 audit ("UI에서 설정한 값이 실제로 geny-executor 런타임까지 전달되어 효과를 내는가")

## Symptom

User opens `CreateSessionModal`, sets `max_turns=10 / timeout=60 / max_iterations=5`, hits Create.

Session is created, `SessionInfo` returns those values, UI displays them. But the executor pipeline runs to **manifest defaults** (`max_iterations=50` from `PipelineConfig`), with **no timeout enforcement** and **no turn cap** beyond whatever the chat layer happens to apply.

## Trace

### UI → API
- `frontend/src/components/modals/CreateSessionModal.tsx:53-55` — initial form state.
- `frontend/src/components/modals/CreateSessionModal.tsx:340-352` — NumberStepper inputs for the 3 fields.
- POST `/api/agents` body carries them.

### API → AgentSession constructor
- `backend/controller/agent_controller.py:135` — handler passes `request.max_turns / timeout / max_iterations` through.
- `backend/service/executor/agent_session_manager.py:728-730` — `AgentSession(...)` call:
  ```python
  max_turns=request.max_turns or 50,
  timeout=request.timeout or 21600.0,
  max_iterations=request.max_iterations or 50,
  ```

### AgentSession constructor → private attrs
- `backend/service/executor/agent_session.py:324-331` — stored as `self._max_turns`, `self._timeout`, `self._max_iterations`.

### What actually uses them?

| Field | Reads | Effect |
|---|---|---|
| `self._max_turns` | `agent_session.py:495` (property), `:2602` (SessionInfo) | **DISPLAY ONLY** |
| `self._timeout` | `agent_session.py:499` (property), `:2603` (SessionInfo) | **DISPLAY ONLY** |
| `self._max_iterations` | `agent_session.py:507` (property), `:2604` (SessionInfo), `:2382` / `:2467` (`effective_max_iterations` for `session_logger.log_stage_execution_start`) | **DISPLAY + LOG ONLY** — never reaches the Pipeline |

### What the executor actually enforces

- `geny-executor/src/geny_executor/core/pipeline.py:860` `Pipeline.run`
- `geny-executor/src/geny_executor/core/pipeline.py:881` `Pipeline.run_stream`
- Both call `state = self._init_state(state)` (line 1133)
- `_init_state` calls `self._config.apply_to_state(state)` (line 1138)
- `apply_to_state` (`config.py:185-187`) sets `state.max_iterations`, `state.cost_budget_usd`, `state.context_window_budget` from `PipelineConfig`.
- `PipelineConfig` is built from the **manifest** at `EnvironmentService.instantiate_pipeline` (`backend/service/environment/service.py:484`) — manifest's `pipeline.max_iterations` (defaults to 50 per executor) wins.

The session-supplied value never overrides this.

## What about `_invoke_pipeline` itself?

`backend/service/executor/agent_session.py:1567` builds a fresh `_PipelineState(session_id=...)` and passes it to `pipeline.run_stream`. **No mutation of `state.max_iterations` / `state.cost_budget_usd` / `state.context_window_budget` before the call.** The executor's `_init_state` then overwrites whatever the state had with the config defaults anyway.

So even if Geny set those fields on the state, they'd be clobbered by `_init_state`.

## Root cause

Two-fold:

1. **Geny doesn't propagate session limits into the Pipeline state** before invocation.
2. **Even if it did, the executor's `Pipeline._init_state` always re-applies its own `PipelineConfig`** — there's no "respect existing state values" path.

## Remediation options

### Option A — Geny-only, post-init override
Inside `_invoke_pipeline` / `_astream_pipeline`, after the `pipeline.run_stream` first event has fired (state is initialized), the executor reads `state.max_iterations` for loop control. Setting it before the run won't survive `_init_state`.

**Verdict:** Not viable. `_init_state` is called *inside* `run_stream`, before the first yield. We can't intercept.

### Option B — Mutate `pipeline._config` per-invocation
Just before `pipeline.run_stream`, mutate `pipeline._config.max_iterations / context_window_budget / cost_budget_usd` to session values. Restore after run. Crude but works.

**Risks:** `Pipeline` is shared per-session in our model (one Pipeline per AgentSession), so mutation is fine — no other caller. But still feels invasive.

### Option C — Build a per-invocation Pipeline copy with overrides
Heavyweight; rebuilds stages every turn.

### Option D — Wrap `pipeline.run_stream` in a max_iterations bound at the Geny layer
Count `iteration` events as they stream; stop iterating once threshold hit, even if executor would have continued. Requires `iteration` event to exist in the stream (verify).

**Decision:** **Option B** for `max_iterations / cost_budget / context_window`.
For `timeout`, wrap the stream in `asyncio.wait_for` (separate concern — not part of executor config).
For `max_turns`, this is a Geny chat-layer concept (turns per CLI invocation, not pipeline iterations). Verify enforcement at chat command path or surface explicitly.

## Tests to add

1. Set `max_iterations=3`, send input; assert `pipeline.complete` event fires with `iterations <= 3`.
2. Set `timeout=2`, send input that takes longer; assert TimeoutError surfaces and session goes to ERROR.
3. SessionInfo round-trip: create with limits, fetch, confirm reads back; restore session, confirm limits preserved.

## Out of scope (this gap doc)

- Cost budget enforcement testing (no LLM in CI test loop).
- Context window enforcement (executor's `TokenBudgetGuard` already covers).
- `max_turns` semantics review — separate analysis if needed.
