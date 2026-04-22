# Cycle 20260422_5 — X7 · VTuber 다마고치 UX 통합

**사이클 시작.** 2026-04-22 (X5F 종료 직후, 운영 피드백 반영).
**특징.** 이 사이클은 plan/05 §9 "한 PR = 한 방향" 원칙에 **예외**로
단일 대형 PR 로 처리. 이유: 사용자의 요구가 "taxonomy 통일 + frontend
가시성" 을 동시에 봐야 체감되는 UX 변경이라, 개별 머지 사이에 부분
상태를 보이는 것이 더 혼란스러움.

## 문제 제기

사용자 피드백 (2026-04-22):

1. **감정 태그 누출.** VTuber chat 에 `[curiosity]` / `[wonder]` /
   `[amazement]` / `[satisfaction]` 등이 raw 로 보임. `AffectTagEmitter`
   가 6개 primary 태그만 인식했기 때문.
2. **호감도 적용 불가시.** 배고픔 / 화남 / 삐짐 같은 다마고치 state 가
   세션 정보 패널에 일절 매핑되지 않아, 동작 여부를 확인할 수 없음.

## 목표

1. **Taxonomy 단일화.** 감정 태그의 3원 분열 (prompt 8개 vs. emitter 6개
   vs. sanitizer 20개) 을 하나의 canonical table 로 통합.
2. **표현 다양성 유지 + 내부 수렴.** Option A 채택 — LLM 은 25+ 개의
   표현 태그를 자유롭게 쓸 수 있고, 각 태그는 6-dim MoodVector 에
   weighted coefficient 로 매핑. Primary 6개 태그의 기존 magnitude 는
   pre-X7 과 byte-identical 유지 (기존 테스트 regression 0).
3. **안전망 strip.** taxonomy 에 없는 lowercase 단일-단어 bracket tag 는
   mutation 은 안 만들되 display 에서 strip. 새 태그가 나타나도 사용자
   화면에는 깨끗한 텍스트만.
4. **Session info API + frontend UI.** `/api/agents/{id}` 응답에
   `creature_state` 스냅샷 추가. InfoTab 에 `CreatureStatePanel` 섹션
   삽입 — mood / bond / vitals / progression 를 progress bar + 레이블
   로 가시화.

## 범위 (단일 PR)

### Backend

- **신규 모듈**: `service.affect.taxonomy` — 단일 source of truth.
  - `MOOD_AXES: Tuple[str, ...]` (6축).
  - `AFFECT_TAG_MAPPING: Dict[str, Dict[str, float]]` — 25+ tag → 축
    coefficient 매핑.
  - `RECOGNIZED_TAGS`, `coefficients_for(tag)` 헬퍼.
  - stdlib-only (emitter + sanitizer 양쪽에서 import 가능).
- **`AffectTagEmitter` 교체**:
  - `AFFECT_TAGS = RECOGNIZED_TAGS` (단일 source).
  - `_apply_tag` 가 taxonomy coefficient 를 순회하며 mutation push.
    Primary 6 의 기존 magnitude 는 정확히 유지.
  - `UNKNOWN_EMOTION_TAG_RE` 안전망 — lowercase 3-20자 single-word
    bracket tag 는 strip-only, mutation 없음. 대문자 routing tag 는
    건드리지 않음.
  - `EmitResult.metadata` 에 `unknown_stripped` 카운터 추가.
- **`text_sanitizer`**:
  - `EMOTION_TAGS = RECOGNIZED_TAGS` (taxonomy 에서 import).
  - `UNKNOWN_EMOTION_TAG_PATTERN` 도 추가해 display 경로에서도 동일
    catch-all 적용.
- **`prompts/vtuber.md`** — 태그 지시 문구를 확장된 taxonomy 로 재작성
  (25+ 태그 그룹별 정리 + `:strength` 옵션 명시).
- **SessionInfo 모델**: `creature_state: Optional[dict]` 필드 추가.
- **`AgentSession.load_creature_state_snapshot()`** async 메서드 추가 —
  provider.load() 로 최신 snapshot 읽어 JSON-friendly dict 반환.
  classic mode / load 실패는 모두 `None` 으로 graceful.
- **`agent_controller.get_agent_session`**: response 직전에
  `info.creature_state = await agent.load_creature_state_snapshot()`
  로 enrich.

### Frontend

- **`types/index.ts`**: `SessionInfo.creature_state` + `CreatureStateSnapshot`
  interface (mood / bond / vitals / progression / timestamps).
- **신규 컴포넌트**: `components/info/CreatureStatePanel.tsx`.
  - 순수 presentational (snapshot + t → JSX). 외부 chart 라이브러리
    미사용 — div 기반 progress bar.
  - 축별 semantic direction: hunger / stress 는 high=red, energy /
    cleanliness 는 high=green. Bond 는 clamp(-100, 100) 후 bar + 원본
    값 레이블.
- **`InfoTab.tsx`**: Thinking Trigger 와 Fields Grid 사이에 panel 삽입.
  `data.creature_state` 가 있을 때만 렌더 (classic mode 자동 hide).
- **i18n ko.ts / en.ts**: `info.creatureState.*` 전체 레이블 세트.

### Tests

- **`tests/service/affect/test_taxonomy.py`** (신규): 8 tests —
  primary 6 coefficient 1.0 pin, 모든 path 가 mood/bond 인지, 유한
  float, alias 일치, 사용자 보고 태그 (wonder/amazement/satisfaction/
  curiosity) 포함 여부.
- **`tests/service/emit/test_affect_tag_emitter.py`** (+9 tests):
  wonder 3축 분배, amazement 2축, satisfaction + bond.affection,
  curiosity=curious alias, unknown lowercase strip, uppercase 보존,
  짧은 bracket 보존, mixed recognized+unknown, primary 6 pre-X7
  regression pin.
- **`tests/service/utils/test_text_sanitizer.py`** (+5 tests +
  파라미터 1개 수정): X7 태그 strip, unknown catch-all strip, routing
  tag 보존, 짧은/숫자 bracket 보존, EMOTION_TAGS 가 taxonomy 와 동일
  객체 reference.
- **기존 `[random_thing]`  는 이제 strip 됨 (의도된 행동 변경)**. 주석
  갱신.

## 불변식 체크

- **executor 무수정.** ✅ executor 0.30.0 의 기능 변경 없음.
- **Pre-X7 primary 6 magnitude byte-identical.** ✅ 기존 emitter 테스트
  전부 pass.
- **FAISS / SQL schema 무영향.** ✅ SessionInfo 응답 필드 1개 추가,
  기존 저장 경로 건드리지 않음.
- **Side-door 재생 금지.** ✅ creature_state API 는 read-only.
  `state.shared` 우회 도입 없음. frontend 는 기존 `/api/agents/{id}`
  endpoint 확장으로 받음.
- **Mutation 4 op.** ✅ `add` 만 사용.
- **Pure additive frontend.** ✅ 기존 fields grid, thinking trigger
  panel 등 그대로. CreatureStatePanel 은 `data.creature_state` 가 없을
  때 숨김.

## 의도된 행동 변경 (비-regression)

한 가지 *의도된* 파라미터 테스트 변경: display sanitizer 가 이전에는
`[random_thing]` 같은 임의 lowercase bracket 을 *보존* 했으나, X7 는
**strip**. 이유: 사용자 보고의 핵심이 "알려지지 않은 감정 태그가 UI 에
깨져 나타난다" 였기 때문에 display cleanliness 를 우선. 업무용 텍스트
패턴 `[note: todo]` / `[INBOX from X]` / `[DM to Y (internal)]` 처럼
공백/대문자/구두점을 포함한 bracket 은 catch-all 의 narrow 규칙
(`\[[a-z][a-z_]{2,19}\]`) 에 매치되지 않아 그대로 보존됨.

## 산출 문서

- `progress/x7_vtuber_tamagotchi_state_visibility.md` — 본 PR 의
  구현 기록.
- `progress/cycle_close.md` — 사이클 종료 (단일 PR 이므로 본 PR
  merge 후 바로 작성).
