# Cycle 20260421_8 — X2 · `SessionLifecycleBus` + `TickEngine`

**사이클 시작.** 2026-04-21
**사전 청사진.** `dev_docs/20260421_6/plan/05_cycle_and_pr_breakdown.md §2`
**선행.** X1 (cycle 20260421_7) — `PersonaProvider` 체계 완결, 5 `_system_prompt` side-door 철거.

## 목표

- 세션 생명주기(생성/삭제/복원/페어/idle/revive/abandoned)를 **bus 를 통한 이벤트 모델** 로 통일.
- 현재 각자 `asyncio.create_task(self._loop())` 로 돌고 있는 **3 개의 tick-like 루프** (thinking_trigger 30s, idle_monitor 60s, curation_scheduler 5m) 를 **unified TickEngine** 에 등록된 spec 으로 이식.
- 이후 X3 (`CreatureState`) 의 decay tick 등록 발판 마련.

## PR 분해 (plan §2 를 본 사이클 기준으로 재확정)

| PR | 브랜치 | 요약 |
|---|---|---|
| PR-X2-1 | `feat/session-lifecycle-bus` | bus 스켈레톤 + 이벤트 enum + 단위 테스트 + 본 cycle 문서 |
| PR-X2-2 | `refactor/lifecycle-emit-from-session-manager` | 기존 호출지에서 bus 로 이벤트 라우팅 |
| PR-X2-3 | `feat/tick-engine` | TickEngine 스켈레톤 + fake-clock 테스트 |
| PR-X2-4 | `refactor/thinking-trigger-on-tick-engine` | ThinkingTrigger 루프 → TickEngine spec |
| PR-X2-5 | `refactor/idle-monitor-on-tick-engine` | 매니저의 idle_monitor 루프 → TickEngine spec (avatar_state_manager 는 재평가 결과 periodic 루프 없음 — 스코프 제외 문서화) |
| PR-X2-6 | `feat/websocket-idle-detection` | WS 단절 기반 `SESSION_ABANDONED` bus emit |

## 산출 문서

- `analysis/01_lifecycle_events_current_state.md` — 현 코드의 생명주기 전환 지점 전수조사.
- `analysis/02_tick_cadences_inventory.md` — 현존 tick-like 루프 전수.
- `plan/01_bus_contract.md` — bus API 계약.
- `plan/02_tick_engine_contract.md` — TickEngine API 계약.
- `progress/pr1..pr6_*.md` — PR 진행 기록.

## 주의

- `avatar_state_manager` 는 **주기 루프가 없는** 반응형 서비스 (analysis/02 Finding 4). plan §2.5 의 "avatar_state_manager 를 TickEngine 으로" 는 코드 기준 재검증 결과 **적용 대상이 아님** — PR-X2-5 는 idle_monitor 만 이식하고 avatar_state_manager 는 다음 cycle (X3) 의 VTuberEmitter mood 업그레이드에서 함께 다룬다.
- `curation_scheduler` 는 X2 범위에 포함되지 않은 별개 루프지만 **3번째 migration 대상** 으로 plan/02 에 후보 등재. 본 cycle 에서는 옮기지 않고 기록만 남긴다.
