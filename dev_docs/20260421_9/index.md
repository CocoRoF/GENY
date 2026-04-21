# Cycle 20260421_9 — X3 · `CreatureState` MVP + Tools + Emitter + Blocks

**사이클 시작.** 2026-04-21
**사전 청사진.** `dev_docs/20260421_6/plan/05_cycle_and_pr_breakdown.md §3` 및 `plan/02_creature_state_contract.md`
**선행.** X1 (cycle 20260421_7) — `PersonaProvider` 완결. X2 (cycle 20260421_8) — `SessionLifecycleBus` + `TickEngine` 완결 (197/197 pass).

## 목표

- **외부 래퍼(전략 D)** 로서의 `CreatureState` 를 Geny 내부에 도입. 세션 턴 사이를 건너 살아있는 다마고치 상태를 보관.
- MutationBuffer 프로토콜 — stage 가 provider 를 직접 쏘지 않고, diff 를 버퍼에 쌓고 `registry.persist` 가 한 번에 커밋.
- SQLite provider + 0001 migration.
- SessionRuntimeRegistry — AgentSession 이 run_turn 전/후로 hydrate/persist.
- Decay 를 X2 의 TickEngine 에 spec 으로 등록 (15 분 주기).
- 4 개 게임 도구 (feed/play/gift/talk) 가 mutation 발행.
- `AffectTagEmitter` 가 LLM 출력 태그 → mutation 변환 (s14 체인).
- X1 의 no-op MoodBlock / RelationshipBlock / VitalsBlock 실제 구현으로 전환.
- `VTuberEmitter` 가 mood 기반 표정 선택.

## PR 분해 (plan §3.2 를 본 사이클 기준으로 재확정)

| PR | 브랜치 | 요약 |
|---|---|---|
| PR-X3-1 | `feat/state-schema` | `backend/service/state/schema/{creature_state,mutation,mood}.py` + 단위 테스트 + 본 cycle 문서 |
| PR-X3-2 | `feat/state-provider-sqlite` | `provider/interface.py`, `provider/sqlite_creature.py`, `migrations/0001_initial.sql` |
| PR-X3-3 | `feat/session-runtime-registry` | `registry.py`, `hydrator.py` |
| PR-X3-4 | `feat/decay-and-tick-registration` | `decay.py`, TickEngine spec 등록 |
| PR-X3-5 | `feat/agent-session-integrates-state` | `service/langgraph/agent_session.py` run_turn hydrate/persist |
| PR-X3-6 | `feat/game-tools-basic` | feed/play/gift/talk 도구 + GenyToolProvider |
| PR-X3-7 | `feat/affect-tag-emitter` | `service/emit/affect_tag_emitter.py`, s14 chain 등록 |
| PR-X3-8 | `feat/mood-rel-vitals-blocks-live` | X1 no-op 블록 → 실제 구현 |
| PR-X3-9 | `feat/vtuber-emitter-mood-aware` | VTuberEmitter mood 기반 표정 |
| PR-X3-10 | `test/state-e2e` | plan/02 §10.3 시나리오 S1-S4 E2E |

## 산출 문서

- `analysis/01_schema_shape_vs_existing_models.md` — 기존 character/session 모델과의 관계 검토.
- `plan/01_schema_field_defaults.md` — default 수치 정당성.
- `progress/pr1..pr10_*.md` — PR 진행 기록.

## 주의

- **Shadow mode.** PR-X3-5 까지는 provider.apply 를 실제 DB write 로 동작시키지만, feature flag (`GENY_GAME_FEATURES`) off 인 경로는 hydrate/persist 를 skip (기본 세션은 영향 없음).
- **MVP 범위 외.** 분산 캐시, 이력 audit log, 다중 character 방문 관계 — plan/02 §11 에 명시.
- **Mutation set 제약.** stage 는 add/append/event 만. set 은 progression 전이나 관리자 경로에서만.
