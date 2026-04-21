# Analysis 02 — 현존 tick-like 루프 전수

**작성일.** 2026-04-21
**목적.** plan §2.3 ("ThinkingTrigger + avatar_state_manager 를 unified TickEngine 으로") 를 *현 코드 기준* 으로 재확정 — 어떤 루프가 실제로 migration 대상인지, 그리고 누락된 루프는 없는지.

## 요약

| # | 루프 | 위치 | 주기 | 소유 방식 | X2 migration? |
|---|---|---|---|---|---|
| 1 | `ThinkingTriggerService._loop` | `service/vtuber/thinking_trigger.py:596-636` | 30s 폴링 + 세션별 120s–3600s 적응형 | `asyncio.create_task(self._loop())` | **YES** (PR-X2-4) |
| 2 | `AgentSessionManager._idle_monitor_loop` | `service/langgraph/agent_session_manager.py:984-1005` | 60s | `asyncio.ensure_future(...)` | **YES** (PR-X2-5) |
| 3 | `CurationScheduler._loop` | `service/memory/curation_scheduler.py:48-56` | 5m | `asyncio.create_task(self._loop())` | **NO** (본 cycle 범위 밖, plan/02 에 후보로만 기록) |
| 4 | `AvatarStateManager` | `service/vtuber/avatar_state_manager.py` | 없음 — 완전 반응형 | — | **NO** (migration 대상 아님) |

## 각 루프 세부

### 1. `ThinkingTriggerService._loop` (PR-X2-4)

```python
# service/vtuber/thinking_trigger.py 말미
async def _loop(self):
    while not self._stopped.is_set():
        await self._tick_all_sessions()
        await asyncio.sleep(self._base_interval)   # 30s
```

- **tick body** — 등록된 VTuber 세션 전부 순회, 각 세션의 idle time 이 임계 (120s–3600s 적응형) 초과면 `[THINKING_TRIGGER]` 또는 `[ACTIVITY_TRIGGER]` 프롬프트를 세션에 주입.
- **적응형 backoff** — 세션별로 마지막 trigger 후 interval 을 동적으로 확장 (응답 없음 N 회 시 backoff). 본 migration 에서도 **보존** 해야 함 — TickEngine spec 안에 "다음 tick 까지의 dynamic delay" hook 을 넣거나, spec 은 30s 고정 + handler 안에서 세션별 skip 판정.
- **선택 — 후자 (handler 내 skip)**. TickEngine 의 spec 은 단일 주기여야 코드가 단순해짐. 적응형 backoff 는 handler 의 private state 로 유지.

### 2. `AgentSessionManager._idle_monitor_loop` (PR-X2-5)

```python
# agent_session_manager.py:984-1005
async def _idle_monitor_loop(self):
    while self._idle_monitor_running:
        await asyncio.sleep(self._idle_monitor_interval)  # 60s
        await self._scan_for_idle_sessions()
```

- **tick body** — 모든 non-VTuber 세션 순회, `last_activity_ts` 가 임계 초과면 `mark_idle()` 호출 (→ analysis/01 의 `SESSION_IDLE` 트리거).
- **migration** — spec cadence 60s, handler 는 `_scan_for_idle_sessions` 를 그대로 호출. idle 판정 + bus emit 은 PR-X2-2 (lifecycle-emit) 에서 이미 붙어 있을 것이므로, 이 PR 은 *루프 소유권만* TickEngine 으로 넘긴다.

### 3. `CurationScheduler._loop` (본 cycle 제외)

- 5 분 주기의 memory curation 트리거. 별개 도메인이고 PR-X2 범위 밖.
- plan/02 의 "이후 migration 대상" 섹션에만 명시. 본 cycle 에서 건드리지 않음.

### 4. `AvatarStateManager` — migration 대상 *아님*

- 전수 조사 결과 `avatar_state_manager.py` 에는 `asyncio.sleep | create_task | ensure_future | while True | async def _loop` 어떤 패턴도 없음.
- 이 서비스는 **완전 반응형** — `update_state(session_id, emotion=...)` 호출 시 내부 dict 를 갱신하고 SSE publish. 주기 루프가 없다.
- plan §2.5 가 "avatar_state_manager 를 TickEngine 으로" 라고 적혀 있었으나 **코드 기준 migration 할 게 없다**. 본 cycle 에서는 touch 하지 않음. 향후 X3 에서 mood 기반 애니메이션 (주기적 blink 등) 이 필요해지면 그때 TickEngine spec 으로 추가.

## Findings

1. **실제 migration 대상은 2 개** (ThinkingTrigger, IdleMonitor). plan §2.4/2.5 의 "PR 2 개" 전제와 정확히 맞는다. 단 §2.5 의 대상이 "avatar_state_manager → idle_monitor" 로 **이름만** 바뀐다.

2. **적응형 backoff 는 spec 에 넣지 않는다.** TickEngine spec 은 단일 주기여야 implementation 이 작다. 세션별 skip 은 handler 책임.

3. **CurationScheduler 는 의도적으로 제외.** X2 끝난 뒤 별도 cycle 또는 X3 의 serendipitous PR 로 옮기면 충분.

4. **WS 기반 `SESSION_ABANDONED` 감지 루프 (PR-X2-6) 는 신규 spec** 이다. 기존 루프 migration 이 아니라 처음부터 TickEngine spec 으로 등록. cadence ≥ 60s 가 적절 (너무 잦으면 CPU 낭비).

## 후속 migration 후보 (본 cycle 밖)

- `CurationScheduler._loop` — 5m 주기, 조건부 실행.
- (X3 도입 예정) `CreatureStateDecay` — 15m 주기, plan 04 §... 참조.
- (향후) VTuber 애니메이션 blink/breathe — 필요시 2s spec.
