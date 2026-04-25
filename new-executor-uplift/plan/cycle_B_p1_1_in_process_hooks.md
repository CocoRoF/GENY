# Cycle B · 묶음 1 — In-process hook callbacks (3 PR)

**묶음 ID:** B.1
**Layer:** EXEC-CORE (HookRunner.register_in_process API) + SERVICE (Geny use case wiring)
**격차:** C.11 — claude-code 의 `registerHookEventHandler` (in-process callback) 와 동등 latency
**의존성:** 없음

---

# Part A — geny-executor (2 PR)

## PR-B.1.1 — feat(hooks): HookRunner.register_in_process API + 직렬 실행

### Metadata
- **Branch:** `feat/in-process-hook-handlers`
- **Repo:** geny-executor
- **Layer:** EXEC-CORE + EXEC-INTERFACE

### Files modified

#### `geny_executor/hooks/runner.py`

기존 `HookRunner` 에 추가:

```python
class HookRunner:
    def __init__(self, ...):
        # ... 기존
        self._in_process_handlers: Dict[HookEvent, List[Callable]] = {}

    def register_in_process(
        self, event: HookEvent, handler: Callable[[HookPayload], Awaitable[Optional[HookOutcome]]],
    ) -> Callable[[], None]:
        """Register an in-process handler for ``event``.
        
        Handler signature:
          async def handler(payload: HookPayload) -> Optional[HookOutcome]:
            ...
            return None                         # let event continue
            return HookOutcome(blocked=True, reason="...")  # short-circuit, skip subprocess
        
        Returns a deregister callable.
        
        Ordering:
          1. in-process handlers (registration order, serial)
          2. subprocess handlers (existing behaviour)
        
        Fail-isolation:
          handler exceptions logged + skipped; other handlers continue.
        """
        self._in_process_handlers.setdefault(event, []).append(handler)
        def deregister():
            try: self._in_process_handlers[event].remove(handler)
            except (KeyError, ValueError): pass
        return deregister

    async def fire(self, event: HookEvent, payload: HookPayload) -> HookOutcome:
        # NEW: in-process first
        for handler in list(self._in_process_handlers.get(event, [])):
            try:
                outcome = await _maybe_await(handler(payload))
            except Exception as e:
                logger.exception("in_process_hook_failed", handler=getattr(handler, "__name__", str(handler)), error=str(e))
                continue
            if outcome and outcome.blocked:
                return outcome
        # existing: subprocess
        return await self._fire_subprocess(event, payload)


async def _maybe_await(value):
    if inspect.isawaitable(value): return await value
    return value
```

### Tests added

`tests/hooks/test_in_process_handlers.py`

- `test_register_then_fire_calls_handler`
- `test_handler_blocked_skips_subprocess`
- `test_handler_exception_does_not_propagate`
- `test_handler_exception_does_not_block_others`
- `test_handlers_called_in_registration_order`
- `test_deregister_removes_handler`
- `test_in_process_runs_before_subprocess`
- `test_sync_handler_supported_via_maybe_await`
- `test_no_handlers_falls_through_to_subprocess`

### Acceptance criteria
- [ ] register_in_process API ship
- [ ] 9 test pass
- [ ] line coverage ≥ 95% (HookRunner)
- [ ] CHANGELOG.md 1.2.0: "Add in-process hook handler API (registerHookEventHandler equivalent)"

### Risk / mitigation
| Risk | Mitigation |
|---|---|
| handler 무한 luper → subprocess never reached | per-event 직렬 실행 + handler 자체에 timeout 적용 (asyncio.wait_for 외부 wrapper) |
| handler 내부 await 가 hang | 본 PR 에서는 timeout 없음 (caller 책임). P2 에서 per-handler timeout 추가 검토 |

---

## PR-B.1.2 — test(hooks): in-process / subprocess 통합 시나리오 + propagation tests

### Metadata
- **Branch:** `test/in-process-hook-integration`
- **Repo:** geny-executor
- **Layer:** EXEC-CORE (test only)
- **Depends on:** PR-B.1.1

### Files added

`tests/hooks/test_integration_in_process.py`

- `test_pre_tool_use_in_process_blocks_subprocess`
- `test_post_tool_use_in_process_modifies_payload`
- `test_permission_denied_in_process_logger_does_not_block`
- `test_in_process_handler_can_inspect_full_payload`
- `test_chain_of_handlers_modifies_state`

### Acceptance criteria
- [ ] 5 통합 시나리오 test pass
- [ ] CHANGELOG.md 1.2.0: 위 PR 의 한 줄에 "with integration tests"

---

# Part B — Geny (1 PR)

## PR-B.1.3 — feat(service): in-process hook use case wiring (permission_logger + task_future)

### Metadata
- **Branch:** `feat/geny-in-process-hooks`
- **Repo:** Geny
- **Layer:** SERVICE
- **Depends on:** Geny pyproject 1.2.0 bump + PR-B.1.1

### Files added

#### `backend/service/hooks/in_process.py` (~150 lines)

```python
"""Service-side in-process hook handlers.

Use case 1 — permission_denied logger:
  사용자가 권한 거부된 tool 호출 시 즉시 in-process logger 기록.
  subprocess 보다 latency 1000x ↓.

Use case 2 — task_future trigger:
  P0.1 의 TaskRunner 가 task 시작 시 in-process Future 등록.
  subprocess 안 거치고 즉시 trigger → testkit 에서 task 완료 대기에 활용.

Use case 3 — skill 실행 전 sandbox 검증:
  SkillTool 실행 전 in-process check (sandbox.allowed?). subprocess 비용 절약.
"""

from geny_executor.hooks import HookRunner, HookEvent, HookOutcome, HookPayload


def install_in_process_hooks(runner: HookRunner):
    runner.register_in_process(HookEvent.PERMISSION_DENIED, _log_permission_denied)
    runner.register_in_process(HookEvent.TOOL_USE_START, _check_skill_sandbox)
    # task_future 는 TaskRunner 에서 등록 (PR-A.1.3 wired)


async def _log_permission_denied(payload: HookPayload) -> Optional[HookOutcome]:
    logger.warning(
        "permission_denied",
        user_id=payload.session_state.get("user_id"),
        tool=payload.tool_name,
        reason=payload.reason,
        latency_ms=0,  # in-process, ~0ms
    )
    return None  # don't block


async def _check_skill_sandbox(payload: HookPayload) -> Optional[HookOutcome]:
    if not payload.tool_name.startswith("skill__"):
        return None
    sandbox = payload.session_state.get("sandbox")
    if sandbox and not sandbox.is_allowed_skill(payload.tool_name):
        return HookOutcome(blocked=True, reason="skill_not_allowed_in_sandbox")
    return None
```

### Files modified

- `backend/main.py` — lifespan 에서 `install_in_process_hooks(pipeline.hook_runner)` 호출

### Tests added

`backend/tests/service/hooks/test_in_process.py`

- `test_install_registers_three_handlers`
- `test_permission_denied_logger_does_not_block`
- `test_skill_sandbox_blocks_disallowed`
- `test_non_skill_tool_passes_through`

### Acceptance criteria
- [ ] 3 handler 등록
- [ ] 4 test pass
- [ ] 운영 환경에서 permission_denied 발생 시 log 즉시 기록 확인

### Risk / mitigation
| Risk | Mitigation |
|---|---|
| handler 가 큰 payload 처리 → 메인 loop 지연 | 본 cycle 의 handler 는 모두 lightweight. heavy 작업 필요 시 asyncio.create_task |

---

## 묶음 합계

| PR | Repo | 의존 |
|---|---|---|
| PR-B.1.1 | executor | — |
| PR-B.1.2 | executor | B.1.1 |
| PR-B.1.3 | Geny | B.1.1 + Geny pyproject 1.2.0 |

총 3 PR. 다음: [`cycle_B_p1_2_auto_compaction.md`](cycle_B_p1_2_auto_compaction.md).
