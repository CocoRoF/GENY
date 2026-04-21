# Plan 02 — `TickEngine` 계약

**작성일.** 2026-04-21
**전제.** `analysis/02_tick_cadences_inventory.md` — 2 개 migration 대상 (ThinkingTrigger, IdleMonitor), 2 개 제외 (CurationScheduler, AvatarStateManager).

## 1. API 개요 (engine.py)

```python
from dataclasses import dataclass
from typing import Awaitable, Callable, Mapping

TickHandler = Callable[[], Awaitable[None]]

@dataclass(frozen=True)
class TickSpec:
    name: str                       # 고유 식별자 — 메트릭 라벨에 사용
    interval: float                 # seconds, minimum 0.1
    handler: TickHandler            # async, zero-arg
    jitter: float = 0.0             # ± seconds; 다중 spec 동시 발화 방지
    run_on_start: bool = False      # True 면 start 직후 즉시 1회 실행

class TickEngine:
    def register(self, spec: TickSpec) -> None: ...
    def unregister(self, name: str) -> None: ...
    async def start(self) -> None: ...            # 각 spec 마다 독립 task 생성
    async def stop(self, *, timeout: float = 5.0) -> None: ...
    def is_running(self) -> bool: ...
    def specs(self) -> Mapping[str, TickSpec]: ...
```

## 2. 동작 규약

- **독립 task 모델.** spec 하나당 `asyncio.create_task(_run_spec(spec))`. 한 spec 의 handler 가 오래 걸려도 다른 spec 에 영향 없음.
- **handler 예외.** `logger.exception` 만 찍고 다음 interval 대기. 루프 자체는 죽지 않음.
- **handler 오버런.** 한 tick 이 interval 보다 길면 다음 interval 까지 대기하지 않고 **즉시** 다음 실행 (drift 보정 없이 "handler 끝나면 interval 대기"). spec 당 단일 in-flight 만 보장.
- **jitter.** uniform(-jitter, +jitter) 를 매 tick 직전 sleep 에 더함. 여러 spec 의 동시 발화 방지 목적. 기본값 0.
- **stop.** `stop()` 은 각 task 에 cancel 보내고 `asyncio.wait(..., timeout=5.0)`. handler 가 cancel 존중해야 (loop 내 `await asyncio.sleep` 만 써야 반드시 cancel 가능).
- **register after start.** 허용. 즉시 task 로 등록되어 sleep → tick.
- **unregister during run.** 해당 task 에 cancel 전송. 현재 실행 중인 handler 는 끝까지 실행 후 종료.

## 3. 테스트 전략 (fake clock)

`asyncio` 의 event loop 에 real sleep 을 쓰면 테스트가 느리고 flaky. `asyncio.sleep` 을 monkey-patch 하는 대신 **FakeClock fixture** 로 spec handler 호출 횟수만 확인.

```python
@pytest.mark.asyncio
async def test_spec_fires_at_interval(monkeypatch):
    calls = []
    async def h(): calls.append(time_now())

    # real interval 0.01s, 50ms wait → 3~6 호출 기대.
    engine = TickEngine()
    engine.register(TickSpec(name="t", interval=0.01, handler=h))
    await engine.start()
    await asyncio.sleep(0.055)
    await engine.stop()
    assert 3 <= len(calls) <= 6
```

- real sleep 을 쓰되 interval 을 ms 단위로 낮춰 실행 시간 <100ms 로 유지.
- jitter 테스트는 `statistics.stdev` 로 관측 분산이 0 보다 큰지만 검증.
- 오버런 테스트는 handler 안에서 `await asyncio.sleep(interval*3)` 하여 "다음 tick 이 오버런 뒤에 이어지는지" 만 확인.

## 4. 메트릭 (PR-X2-4/5 에서 덧붙임)

- `tick_handler_duration_ms{name=<spec.name>}` — 각 tick 에서 handler 실행 시간.
- `tick_handler_errors_total{name=<spec.name>}` — raise 횟수.
- `tick_handler_skipped_total{name=<spec.name>}` — (선택) handler 내부 조건부 skip 을 spec 이 알아야 할 때.

본 PR (PR-X2-3) 은 메트릭 훅 *자리* 만 둔다 (`self._on_tick_complete(name, duration_ms)` no-op). 실제 metric 은 이후 PR.

## 5. spec 등록 예시 (미래 PR)

```python
# PR-X2-4 — thinking_trigger migration
engine.register(TickSpec(
    name="thinking_trigger",
    interval=30.0,
    handler=thinking_trigger_service.scan_all,
    jitter=2.0,
    run_on_start=False,
))

# PR-X2-5 — idle monitor migration
engine.register(TickSpec(
    name="idle_monitor",
    interval=60.0,
    handler=agent_session_manager.scan_for_idle,
    jitter=3.0,
))

# PR-X2-6 — WS abandoned detector
engine.register(TickSpec(
    name="ws_abandoned_detector",
    interval=60.0,
    handler=ws_connection_tracker.scan,
))
```

- thinking_trigger 의 "세션별 적응형 backoff" 는 handler 안에서 세션별 skip 판정으로 해결 (analysis/02 §1 참조). spec 자체는 고정 주기.

## 6. migration 후보 (본 cycle 밖)

- `service/memory/curation_scheduler.py` — 5m 주기. 별도 cycle 에서 이식.
- (X3) CreatureStateDecay — 15m 주기, spec name="creature_decay".

## 7. 구현 위치

- `backend/service/tick/__init__.py` — 재수출.
- `backend/service/tick/engine.py` — TickEngine + TickSpec.
- 생성은 PR-X2-3. 본 PR (PR-X2-1) 에서는 **TickEngine 을 만들지 않는다** — bus 만.
