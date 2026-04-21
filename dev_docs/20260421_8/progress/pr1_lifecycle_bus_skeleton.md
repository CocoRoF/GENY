# PR-X2-1 · `feat/session-lifecycle-bus` — 진행 기록

**Date.** 2026-04-21
**Status.** Implemented, 12/12 bus tests pass. 기존 persona 36 case 회귀 없음.

## 범위

X2 cycle 의 청사진 문서 5 편 + `SessionLifecycleBus` pub/sub 레일만. 기존 호출지에서 emit 하는 작업은 PR-X2-2 에 분리.

## 적용된 변경

### 1. Cycle 문서 (`dev_docs/20260421_8/`)

- `index.md` — 6 PR 분해 + avatar_state_manager 가 X2 범위에서 빠지는 이유 + curation_scheduler 는 후속 cycle 로 분리하는 이유 기록.
- `analysis/01_lifecycle_events_current_state.md` — 7 이벤트 확정 + 각 현재 코드 위치 매핑 + cascade / 예외 (VTuber idle 예외) 정리.
- `analysis/02_tick_cadences_inventory.md` — 실제 tick 루프 3 개 확인 (ThinkingTrigger, IdleMonitor, CurationScheduler) + AvatarStateManager 가 반응형이라 migration 대상 아님을 grep 으로 확인.
- `plan/01_bus_contract.md` — bus API 계약 (async-only handler, 순차 await, copy-on-write subscribe, handler 예외 격리).
- `plan/02_tick_engine_contract.md` — TickEngine 계약 (독립 task 모델, jitter, overrun 처리, fake-clock 테스트 전략).

### 2. `backend/service/lifecycle/` (신규)

- `events.py` — `LifecycleEvent` enum (7 값) + `LifecyclePayload` frozen dataclass.
- `bus.py` — `SessionLifecycleBus` + `SubscriptionToken`. 주요 결정:
  - handler 는 async only. sync 함수 전달 시 `TypeError`.
  - `emit` 은 `self._per_event[ev] + self._catch_all` 스냅샷을 순차 await.
  - `subscribe` / `unsubscribe` 는 리스트 전체를 치환 (copy-on-write) — 현 emission 중 mutate 돼도 current dispatch 에 영향 없음.
  - handler 내 예외는 `logger.exception` 으로만 기록, 다음 handler 계속 실행.
  - `SubscriptionToken` 은 UUID 기반 — 반환 값으로만 unsubscribe 가능.
- `__init__.py` — 공용 심볼 재수출.

### 3. `backend/tests/service/lifecycle/test_bus.py` (신규)

12 case:

1. `test_emit_fires_subscribed_handler` — 기본 subscribe → emit → 1 회 호출 + payload 확인.
2. `test_subscribe_all_fires_for_every_event` — catch-all 이 7 이벤트 전부 수신.
3. `test_multiple_handlers_invoked_in_registration_order` — 등록 순서 보존.
4. `test_unsubscribe_removes_handler` — per-event token 해제.
5. `test_unsubscribe_all_token_works` — catch-all token 해제.
6. `test_handler_exception_does_not_break_subsequent_handlers` — 예외 격리.
7. `test_emit_without_subscribers_is_noop` — 구독자 없는 emit OK.
8. `test_emit_fills_when_timestamp` — `payload.when` 이 `time.time()` 범위에.
9. `test_meta_is_passed_through` — emit kwargs 가 payload.meta 로 그대로.
10. `test_copy_on_write_during_emit` — emit 중 subscribe 해도 current dispatch 영향 없음.
11. `test_sync_handler_rejected` — sync 함수 subscribe 시 TypeError.
12. `test_handlers_awaited_sequentially` — handler 가 `await asyncio.sleep` 해도 다음 handler 는 완료 후에만 실행.

## 테스트 결과

- `backend/tests/service/lifecycle/` — **12/12 pass** (0.06s).
- `backend/tests/service/persona/` — **36/36 pass** 회귀 없음 (X1 완결 상태 유지).

## 의도적 비움

- **기존 호출지 emit 배선 없음.** `agent_session_manager.create_agent_session`, `agent_session.mark_idle` 등에서 `bus.emit` 을 부르는 작업은 PR-X2-2 에 분리. 본 PR 은 *레일* 만.
- **bus 인스턴스의 공용 위치 없음.** manager 에 `self._lifecycle_bus` 로 들일지, app state 로 올릴지는 PR-X2-2 에서 call-site 들과 함께 결정.
- **metric 훅 없음.** `lifecycle_event_total{event=...}` 은 PR-X2-2 의 subscribe_all handler 로 추가.
- **TickEngine 은 본 PR 에 없음.** plan/02 계약만 작성, 구현은 PR-X2-3.

## 다음 PR

**PR-X2-2 · `refactor/lifecycle-emit-from-session-manager`** — `AgentSessionManager.{create,delete,pair,restore}` + `AgentSession.{mark_idle, _revive}` 에서 bus.emit 호출. WS 는 PR-X2-6 에서 별도.
