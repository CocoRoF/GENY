# Cycle 20260422_5 — X7 종료 정리

**Date.** 2026-04-22
**Shipped.** 단일 대형 PR (`feat/tamagotchi-state-visibility-and-tag-coverage`)
+ 이 close doc = 2-PR 사이클. 예외 사이클 — 사용자 피드백의
"taxonomy 통일 + frontend 가시성" 두 축은 동시에 보여야 체감되는 UX
변경이라 단일 PR 로 묶음.

## 정착한 것

### Backend

| 지점 | 변경 |
|---|---|
| `service.affect.taxonomy` (신규) | 25+ tag → 6-dim coefficient mapping + helpers. stdlib-only. |
| `service.emit.affect_tag_emitter` | 하드코딩 6-태그 → taxonomy 기반. 안전망 catch-all regex. metadata.unknown_stripped 추가. |
| `service.utils.text_sanitizer` | EMOTION_TAGS 를 taxonomy 에서 import. UNKNOWN_EMOTION_TAG_PATTERN 추가. |
| `prompts/vtuber.md` | 8-태그 지시 → 25+ 태그 그룹별 정리 + `:strength` 옵션 명시. |
| `service.claude_manager.models.SessionInfo` | `creature_state: Optional[dict]` 필드 추가. |
| `service.langgraph.agent_session` | `load_creature_state_snapshot()` async 메서드 추가. |
| `controller.agent_controller.get_agent_session` | UI endpoint 에서 `creature_state` enrich. |

### Frontend

| 지점 | 변경 |
|---|---|
| `types/index.ts` | `SessionInfo.creature_state` + `CreatureStateSnapshot` interface. |
| `components/info/CreatureStatePanel.tsx` (신규) | vitals/bond/mood 3 그룹 progress bar panel. |
| `components/tabs/InfoTab.tsx` | Thinking Trigger 와 Fields Grid 사이에 panel 삽입. |
| `lib/i18n/ko.ts` + `en.ts` | `info.creatureState.*` 전체 레이블 세트. |

### 테스트

- `tests/service/affect/test_taxonomy.py` (신규, 8 tests).
- `tests/service/emit/test_affect_tag_emitter.py` (+9 tests → 36 total).
- `tests/service/utils/test_text_sanitizer.py` (+5 tests + 1 param 수정).

**X7 총 +22 tests. 188 backend tests pass, regression 0.**

## 불변식 체크

X7 PR 을 통해 깨지지 않은 것:

1. **executor 는 게임을 모른다.** ✅ executor 수정 없음.
2. **Pre-X7 primary 6 magnitude byte-identical.** ✅ regression pin
   test 가 모든 값 확인.
3. **Pure additive.** ✅ SessionInfo 필드 1개 추가. 기존 23개 필드 무변.
4. **Retriever / FAISS / SQL schema 무영향.** ✅ 본 사이클 관여 지점
   없음.
5. **Mutation 4 op.** ✅ `add` 만 사용.
6. **Side-door 재생 금지.** ✅ creature_state API 는 read-only.
7. **Frontend pure additive.** ✅ classic mode 에선 panel 자동 숨김.

## 의도된 행동 변경 (비-regression, 명시)

display sanitizer 가 이전에는 `[random_thing]` 같은 임의 lowercase
bracket 을 보존했으나 X7 는 **strip**. narrow regex 로 업무용 bracket
(`[note: todo]`, `[INBOX from X]` 등) 은 해치지 않음. 사용자 보고의
"알려지지 않은 감정 태그 leak" 이 핵심 요구라 display cleanliness 를
우선함.

## 의도적으로 미이식 (다음 사이클 후보)

1. **두 번째 plugin 사례.** non-Tamagotchi 도메인의 GenyPlugin 을 하나
   작성 — 이 때 `session_runtime` attribute schema coordination 문제가
   실제로 실증됨 (X5F 에서 정식 접점만 깔아 둠).
2. **X6F last-mile.** `ShortTermMemory.add_message` → `record_message`
   → `AgentSessionManager` 가 `state.shared[AFFECT_TURN_SUMMARY_KEY]`
   를 소비하는 3-4 레이어 write-path 배선.
3. **Taxonomy coefficient 튜닝.** 현재는 heuristic — 운영 데이터로
   tuning 해야 진짜 값이 나옴. PR-X6-3 (bucket) 과 같은 계열의
   data-dependent 작업.
4. **CreatureStatePanel 폴링 / live update.** 현재는 InfoTab mount
   시 1회 fetch. 실시간 갱신이 필요해지면 기존 agent_progress SSE 에
   creature_state_update 이벤트 합류 가능.

## 산출물 요약

```
# backend
backend/service/affect/taxonomy.py                          # NEW
backend/service/emit/affect_tag_emitter.py                  # rewritten
backend/service/utils/text_sanitizer.py                     # taxonomy import + catch-all
backend/prompts/vtuber.md                                   # tag list expanded
backend/service/claude_manager/models.py                    # +creature_state field
backend/service/langgraph/agent_session.py                  # +load_creature_state_snapshot
backend/controller/agent_controller.py                      # enrich SessionInfo

# frontend
frontend/src/types/index.ts                                 # +CreatureStateSnapshot
frontend/src/components/info/CreatureStatePanel.tsx         # NEW
frontend/src/components/tabs/InfoTab.tsx                    # panel slot
frontend/src/lib/i18n/ko.ts                                 # +info.creatureState.*
frontend/src/lib/i18n/en.ts                                 # +info.creatureState.*

# tests
backend/tests/service/affect/test_taxonomy.py               # NEW — 8 tests
backend/tests/service/emit/test_affect_tag_emitter.py       # +9 tests
backend/tests/service/utils/test_text_sanitizer.py          # +5 tests + 1 updated

# docs
dev_docs/20260422_5/index.md
dev_docs/20260422_5/progress/x7_vtuber_tamagotchi_state_visibility.md
dev_docs/20260422_5/progress/cycle_close.md                 # this
```

## 다음 사이클

plan/05 범위는 X6F 에서 이미 100% 완결. X7 는 plan 외의 **운영
피드백 기반 UX 통합**. 다음 사이클은 사용자의 직접 요구가 생기는 시점에
새로운 목표로 진입.

본 사이클 종료.
