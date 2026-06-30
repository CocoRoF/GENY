# 정체성/연속성 메모리 버그 — 근본원인 + 메모리 모델 평가 + 수정안

> 2026-06-30 · 7-agent 심층조사 + 적대적 검증 + 코드 직접 확인. 증상: VTuber("엘렌")가
> 사용자를 "사장님"이라 부르다가 갑자기 "안녕 엘렌이야 … 너는 뭐라고 부르면 돼?"라고 콜드스타트.

## 1. 근본 원인 (코드로 검증됨)

증상은 **두 신호의 디커플링 + 비영속성**에서 나온다.

### (A) "어떻게 부를지 물어봐"는 first-encounter 오버레이가 호칭 인지와 무관하게 발동
- `prompts/vtuber_characters/_shared_first_encounter.md:13` 가 명시적으로 *"Ask ONE concrete question — about how to address them"* 지시 → 이게 "뭐라고 부르면 돼?"의 출처.
- 이 오버레이는 `CharacterPersonaProvider.resolve()`에서 **`_is_first_encounter(state)` 가 True일 때만** 붙는다 (`character_provider.py:218-221`).
- `_is_first_encounter` = **`Bond.familiarity ≤ 0.5`** 면 True (`character_provider.py:266,284,287`). (creature가 없으면 방어적으로 False → 즉 콜드스타트는 creature가 **있고** familiarity가 낮을 때 발동.)
- **핵심 결함**: "호칭을 아는가"(대화/메모리에서 학습한 "사장님")와 "친밀도 familiarity"는 **별개 신호**다. 에이전트가 이미 "사장님"을 알아도 familiarity가 ≤0.5면 오버레이가 발동 → **아는데도 다시 물어본다.**

### (B) familiarity가 관계를 내구적으로 반영하지 못함
- `creature_state.py:58` `familiarity: float = 0.0` (기본값이 ≤0.5 = first-encounter 밴드).
- creature는 `character_id` 키로 state_provider에서 load (`agent_executor.py:150`, `agent_session.py:4554`). character_id가 컨텍스트(신규 세션/오토노머스/재기동) 간 불안정하거나 familiarity 누적·저장이 끊기면 → 매번 0.0 로드 → first-encounter 재발동.
- `_rehydrate`는 **system_prompt(static_override)만 복원**하고 creature/bond는 복원 안 함 (`agent_session_manager.py:1637`).

### (C) 호칭을 내구적으로 always-inject 저장하는 자동 경로가 없음
- 내구 저장소(`critical/` 카테고리 + pinned 레이어 → "# Pinned Facts" 항상 주입)는 **존재**한다.
- 그러나 자동 승격 콜백 `pin_policy.promote_to_critical`는 **죽은 코드**(어디서도 호출 안 됨 — grep 0). 호칭을 critical/에 자동 기록하는 장치가 없어, 에이전트가 자발적으로 `memory_write`(critical)를 호출하지 않으면 "사장님"은 **세션 내 휘발 버퍼**(`character_provider._static_override/_character_append/_context_append`) + 최근 대화에만 존재 → 콜드 컨텍스트(오토노머스/재기동)에서 소실.

> 적대적 검증 정정: (i) `pin_policy.promote_to_critical`는 dead code(자동승격 OFF가 원인이 아니라 **자동 캡처 부재**가 원인), (ii) pinned 레이어 budget(기본 0.30)은 기본경로에서 정상 → "budget 0으로 silent drop"은 오설정 엣지케이스. (iii) s02 `iteration==0` 게이트는 매 run 정상 재발동 → 원인 아님(무죄).

## 2. 메모리 모델 평가 (노트-파일 그래프가 최선인가?)

**판정: 노트 그래프는 시각화·다홉(multi-hop) 검색엔 옳지만, 정체성/연속성엔 틀린 1차 추상화.**
- 수렴 증거(Zep bi-temporal, Mem0 ADD/UPDATE/DELETE, MemGPT/Letta core 'human' block, generative-agents)는 모두 **always-on 프로필/코어 레이어**를 검색 레이어와 분리한다.
- 그래프 re-rank는 컴패니언 볼트를 지배하는 **단일홉 조회**("내 호칭이 뭐였지")를 오히려 -5~16% 악화(GraphRAG-Bench), 다홉에서만 이득.
- 현재 `critical/`는 **노트 전체 단위**(거칠고 append됨) → "호칭" 한 사실이 마크다운에 묻혀 **독립 갱신/무효화 불가** → 모순된 인사가 공존하는 근본 이유.

**권고:**
- 노트 그래프 = Opsidian 시각화 + 주제 클러스터 + **게이트된 additive 다홉 PPR**(이미 Phase 4, 기본 안전)에 유지. 정체성의 운반체로 쓰지 말 것.
- **별도의 fact-level, always-injected 정체성/관계 프로필 추가**: 행 1개=사실 1개(호칭/이름/핵심선호/관계상태) + **supersede/valid-time**(`superseded_by`) → "사용자가 호칭을 바꿨다"가 옛 사실을 **무효화**(모순 노트 공존 방지). `critical/` + `load_pinned → "# Pinned Facts"` 시밍 재사용. Neo4j 불필요.

## 3. 수정안 (단계별, 블래스트 반경 큰 영역이므로 신중)

- **Fix 1 (최소·최고ROI, 증상 직격)**: first-encounter 오버레이의 "호칭 물어보기"를 **호칭 인지 여부와 연동**. 호칭(또는 내구 정체성 사실)이 이미 있으면 "어떻게 부를지 물어봐" 지시를 **억제**(오버레이의 나머지 톤 가이드는 유지). → 알면서 다시 묻는 증상 즉시 제거.
- **Fix 2 (내구 정체성 캡처)**: 사용자가 호칭을 정하거나 바꾸면 **즉시(24h 큐레이션 cron 아님) critical/에 fact-level upsert** + supersede. (죽은 promote 콜백을 살리거나, 턴 레벨 경량 추출기로 `memory_write(critical)` 경로 호출.)
- **Fix 3 (콜드 컨텍스트 봉합)**: `_rehydrate`에서 creature_state 스냅샷 + 페르소나 버퍼를 best-effort 복원 → 재기동/오토노머스 첫 턴이 관계를 인지. (`agent_session_manager.py:1637`)
- **Fix 4 (first-encounter 래치)**: familiarity가 한 번 0.5를 넘었거나 호칭이 정해지면 **내구 "이미 만남" 래치** → familiarity가 낮게 재계산돼도 재소개 안 함. (creature_state에 `met:bool` 추가 또는 critical 사실 존재로 판정.)

**권장 착수 순서**: Fix 1 (페르소나 오버레이 조건화, 가장 안전·국소) → Fix 2 (자동 캡처) → Fix 3/4 (내구성). Fix 1은 페르소나 resolve 한 곳 + 정체성 사실 조회만 건드리므로 블래스트 반경 최소.

## 4. 주의
- 페르소나/그리팅은 **모든 VTuber 턴**에 영향(블래스트 큼) → 변경은 국소·방어적으로, 라이브 검증 필수.
- Fix 1은 "이미 호칭을 안다"는 내구 신호가 필요 → Fix 2의 최소판(호칭 사실 존재 확인)과 함께 가는 게 견고.
