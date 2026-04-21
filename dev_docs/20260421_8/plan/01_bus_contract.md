# Plan 01 — `SessionLifecycleBus` 계약

**작성일.** 2026-04-21
**전제.** `analysis/01_lifecycle_events_current_state.md` — 7 이벤트 확정.

## 1. 이벤트 (events.py)

```python
from enum import Enum
from dataclasses import dataclass, field
from typing import Mapping, Any
from time import time


class LifecycleEvent(str, Enum):
    SESSION_CREATED   = "session_created"
    SESSION_DELETED   = "session_deleted"
    SESSION_RESTORED  = "session_restored"
    SESSION_PAIRED    = "session_paired"
    SESSION_IDLE      = "session_idle"
    SESSION_REVIVED   = "session_revived"
    SESSION_ABANDONED = "session_abandoned"


@dataclass(frozen=True)
class LifecyclePayload:
    event: LifecycleEvent
    session_id: str
    when: float                              # epoch seconds; emit 시 자동 채움
    meta: Mapping[str, Any] = field(default_factory=dict)
```

- `meta` 는 이벤트별로 자유롭게 싣는다. 권장 키:
  - `SESSION_CREATED`: `{role, is_vtuber, paired_parent?, env_id?}`
  - `SESSION_DELETED`: `{hard: bool, cascade?: str}` (cascade = 'linked_worker' 등)
  - `SESSION_RESTORED`: `{cascade?: str}`
  - `SESSION_PAIRED`: `{vtuber_id, worker_id}`
  - `SESSION_IDLE`: `{idle_since: float, reason: 'timeout' | 'explicit'}`
  - `SESSION_REVIVED`: `{revive_count: int}`
  - `SESSION_ABANDONED`: `{last_ws_seen: float, grace_seconds: int}`

## 2. bus.py API

```python
class SessionLifecycleBus:
    def subscribe(self, event: LifecycleEvent, handler: Handler) -> SubscriptionToken: ...
    def subscribe_all(self, handler: Handler) -> SubscriptionToken: ...
    def unsubscribe(self, token: SubscriptionToken) -> None: ...
    async def emit(self, event: LifecycleEvent, session_id: str, **meta: Any) -> None: ...
```

- **handler signature.** `async def handler(payload: LifecyclePayload) -> None`.
- **동기 handler 허용 안 함.** 훅 내부에서 store 쓰기/네트워크 호출이 생길 수 있으므로 async-only. 동기 로깅이 필요하면 sync 코드를 async 로 감싸서 등록.
- **handler 예외 격리.** 한 handler 가 raise 해도 나머지 handler 는 순차 호출. 예외는 `logger.exception` 만. 이 정책은 X2 전 구간에 공통.
- **호출 순서.** 등록 순서를 보장. 우선순위 기반 스케줄은 X2 범위 밖.
- **emit 내부 동작.** `asyncio.gather(*handlers, return_exceptions=True)` 가 아니라 **순차 await**. 순차인 이유:
  1. handler 가 수 ms 수준이므로 병렬 이득 없음.
  2. ordering 관측 가능성 (테스트에서 결정론적).
  3. 후속 handler 가 앞선 handler 의 DB write 에 의존할 수 있음.

  Trade-off — 한 handler 가 오래 걸리면 뒤 handler 가 밀림. 이건 handler 가 "짧아야 한다" 는 규약으로 해결, 무거운 작업은 fire-and-forget task 로 내부에서 처리.
- **동기 호출자 우회.** 호출 지점이 sync 인 경우 (ex. 기존 `agent_session.py` 의 mark_idle) 는 임시로 `asyncio.ensure_future(bus.emit(...))` 로 띄우고 결과 기다리지 않는다. plan §2 의 "sync bleed" 는 이 방식으로 해결.

## 3. 구독자 예시 (미래)

```python
# X3 — CreatureState hydrator 가 구독:
bus.subscribe(LifecycleEvent.SESSION_CREATED, hydrator.ensure_creature_state)
bus.subscribe(LifecycleEvent.SESSION_REVIVED, hydrator.rehydrate_after_revive)
```

- 본 PR (PR-X2-1) 은 구독자 zero — bus 는 그냥 "pub/sub container" 로만 존재. 실제 구독자는 X3 부터.

## 4. 동시성 / 스레드 안전성

- `subscribe` / `unsubscribe` 는 **루프 실행 중** 에도 호출 가능해야 함 (future handler 추가).
- 구현: subscribe 시 내부 `dict[event, list[Handler]]` 를 *복사-치환* (copy-on-write). emit 은 복사 시점의 리스트를 iterate — 루프 중 mutate 해도 current emission 영향 없음.

## 5. 테스트 (test_bus.py)

- `test_emit_fires_subscribed_handler` — subscribe → emit → handler 1 회 호출, payload 정확.
- `test_subscribe_all_fires_for_every_event` — `subscribe_all` 훅이 7 이벤트 전부에 반응.
- `test_multiple_handlers_invoked_in_registration_order` — 같은 이벤트에 3 handler, 순서대로 호출.
- `test_unsubscribe_removes_handler` — token 반납 후 emit 시 호출 안 됨.
- `test_handler_exception_does_not_break_subsequent_handlers` — h1 raise, h2 는 여전히 호출.
- `test_emit_without_subscribers_is_noop` — 구독자 없는 이벤트 emit 시 raise 없음.
- `test_emit_fills_when_timestamp` — payload.when 이 time.time() ± ε.
- `test_meta_is_passed_through` — `bus.emit(..., foo=1, bar="x")` 가 payload.meta 에 dict 로.
- `test_copy_on_write_during_emit` — emit 중 새 handler subscribe 해도 현 emission 에는 영향 없음. (concurrency 보장 확인)

## 6. 본 PR 의 범위 밖

- PR-X2-1 은 **pub/sub 레일 자체만** 만든다. 기존 호출지에서 emit 을 부르는 작업은 **PR-X2-2** 몫.
- 메트릭 (`lifecycle_event_total{event=...}`) 도 PR-X2-2 에서 bus 에 붙이거나 별도 subscribe_all handler 로 추가.
