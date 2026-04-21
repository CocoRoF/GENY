# PR-X3-3 · `feat/session-runtime-registry` — 진행 기록

**Date.** 2026-04-21
**Status.** Implemented, 284/284 pass (기존 270 + 신규 14). `CreatureState` 를 pipeline state 에 주입/회수하는 턴-수명 브릿지 완결.

## 범위

plan/02 §4 의 `SessionRuntimeRegistry.hydrate / persist` 을 구현하고 `state.shared` 주입 키를 상수로 고정. 얕은 래퍼로 `hydrate_state` / `persist_state` 함수도 노출.

본 PR 은 **registry 단위** 까지만. `AgentSession.run_turn` 으로의 호출 배선은 PR-X3-5.

## 적용된 변경

### 1. `backend/service/state/registry.py` (신규)

```python
class SessionRuntimeRegistry:
    def __init__(self, *, session_id, character_id, owner_user_id, provider): ...
    async def hydrate(self, state) -> CreatureState: ...
    async def persist(self, state) -> CreatureState: ...
    @property snapshot -> CreatureState | None
```

- `hydrate` 는 provider.load → `state.shared[CREATURE_STATE_KEY]` / `[MUTATION_BUFFER_KEY]` / `[SESSION_META_KEY]` 주입 + `state.hydrated` 이벤트.
- `persist` 는 buffer items → provider.apply → `CREATURE_STATE_KEY` 갱신 + `state.persisted` (혹은 conflict 시 `state.conflict` emit 후 re-raise).
- `state.add_event` 가 없거나 예외를 던지면 **조용히 삼킴**. 관찰성이 없다고 턴이 죽진 않음.
- state 에 `.shared` 가 없으면 `AttributeError` — 진짜 잘못된 객체를 받은 경우만 실패.

### 2. `backend/service/state/hydrator.py` (신규)

`hydrate_state(state, registry)` / `persist_state(state, registry)` — 얇은 free-function dispatch. 일부 호출지가 클래스 import 없이 쓸 수 있게.

### 3. `backend/service/state/__init__.py` (수정)

`SessionRuntimeRegistry`, `CREATURE_STATE_KEY`, `MUTATION_BUFFER_KEY`, `SESSION_META_KEY`, `hydrate_state`, `persist_state` 재수출.

### 4. 테스트 (신규 14)

`backend/tests/service/state/test_registry.py` — 실제 `PipelineState` 를 끌어오지 않고 `_StubState` (shared + add_event) 로 빠르게 검증:

1. `test_hydrate_installs_keys_on_shared` — 3개 슬롯 전부 세팅.
2. `test_hydrate_emits_hydrated_event` — payload 형태 검증.
3. `test_hydrate_propagates_snapshot_as_provider_result`.
4. `test_persist_without_hydrate_raises_runtime_error`.
5. `test_persist_requires_mutation_buffer_key`.
6. `test_persist_applies_mutations_from_buffer` — add + append 동시.
7. `test_persist_emits_persisted_event_with_mutation_count`.
8. `test_persist_empty_buffer_is_noop_but_still_emits_event` — mutations=0.
9. `test_persist_emits_conflict_and_reraises` — monkey-patch 로 `StateConflictError` 강제.
10. `test_hydrate_persist_works_without_add_event` — `.add_event` 없는 state 객체.
11. `test_event_sink_errors_are_swallowed` — add_event 가 raise 해도 완주.
12. `test_registry_snapshot_tracks_latest_after_persist`.
13. `test_hydrator_free_functions_dispatch_to_registry`.
14. `test_state_without_shared_raises_attribute_error`.

## 테스트 결과

- `backend/tests/service/state/` — **87/87 pass** (73 기존 + 14 신규).
- `backend/tests/service/tick/` — **19/19**.
- `backend/tests/service/lifecycle/` — **27/27**.
- `backend/tests/service/persona/` — **36/36**.
- `backend/tests/service/langgraph/` — **104/104**.
- `backend/tests/service/vtuber/test_thinking_trigger_tick.py` — **11/11**.
- 총 **284/284 pass**.

## 설계 결정

- **`state` 를 Any 로 받는다.** `geny_executor.core.state.PipelineState` 에 정식 바인드 하면 공용 라이브러리에 대한 type-level 의존이 생김. registry 는 duck type (`.shared` + 선택적 `.add_event`) 만 요구해서 유닛 테스트에서는 stub 으로 충분.
- **이벤트 실패는 무해하게.** plan/02 §4.3 은 persist 실패 시에도 "유저 응답은 이미 성공" 을 수용한다고 함. 동일 원칙으로 관찰성 실패도 통신 플로우를 깨지 않게.
- **snapshot 갱신.** persist 후 `self._snapshot = new_state` — registry 가 장수한다면 다음 persist 가 stale 이 되지 않음. 다만 AgentSession (PR-X3-5) 은 턴 당 새 registry 를 만들 예정이므로 현재는 보수적 안전장치.

## 의도적 비움

- **Retry.** `StateConflictError` 의 retry 는 AgentSession (PR-X3-5) 단에서 결정. registry 는 단일 시도로 raise.
- **Catch-up tick.** plan/02 §4.1 의 `if now > snap.last_tick_at + CATCHUP_THRESHOLD` catch-up 은 `DecayPolicy` 가 필요하므로 PR-X3-4 에서 추가.
- **Streaming 스트림 종료 훅.** plan/02 §4.4 — agent_session 통합 PR 에서 결정.

## 다음 PR

PR-X3-4 `feat/decay-and-tick-registration` — `DecayPolicy` + `DEFAULT_DECAY` + `tick(character_id, policy)` provider 확장 + TickEngine 등록 + catch-up 훅.
