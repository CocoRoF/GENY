# Analysis 01 — CreatureState schema vs 기존 모델

**작성일.** 2026-04-21

## 1. 기존에 있는 것

Geny 는 다음 모델/저장소를 이미 가지고 있다:

- `backend/database/models/character.py` — 캐릭터 정의 (name, persona, manifest_id 등 정적 메타).
- `backend/database/models/session.py` — 대화 세션. character_id FK + user FK + 메시지 스레드.
- `backend/database/models/persona.py` — Persona 선언 (X1 에서 provider 체계로 통합).
- 메시지/이벤트/로깅 계열 — 본 스키마와 무관.

**즉 "캐릭터 정의" 와 "대화 스레드" 는 이미 있다.** 없는 것은 "캐릭터의 살아있는 상태" —
vitals (배고픔, 에너지 등), bond (애정/신뢰), progression (나이, stage), mood (감정 EMA).

## 2. CreatureState 는 어디에 붙는가

**새 저장소: `creature_state` 테이블 (PR-X3-2 에서 생성).**
- PK: `character_id` (character 테이블과 1:1).
- 일자일캐릭터 관계. 같은 유저가 여러 character 를 가지면 행이 여러 개.
- JSON blob 컬럼 (`data_json`) 에 `CreatureState` 직렬화 결과를 담고 스키마 버전 (`schema_version`) / OCC (`row_version`) / 타임스탬프 메타만 top-level 컬럼.

**character 테이블 자체에는 손대지 않는다.** character 는 정적 선언, creature_state 는 런타임 상태. 분리 유지.

## 3. 기존 Persona / manifest 와의 관계

- `Progression.manifest_id` 가 있음. 현재 character 의 manifest 와 독립적으로 *현재 적용된* manifest 를 기록. stage 전환 (X4) 때 이 값이 갱신.
- 따라서 character.manifest_id 는 "기본 manifest", creature_state.progression.manifest_id 는 "현재 활성 manifest".
- 초기 hydrate 에서 character.manifest_id 를 default 로 복사.

## 4. 기존 mood / emotion 관련 코드

`backend/service/` 안에 감정 추출 관련 코드를 검색:

- `emotion_extractor` 류가 있다면 그 벡터 표현을 `MoodVector` 가 상속/재사용해야 한다.
- 검색 결과 (PR-X3-1 구현 시점) 기준: 동일한 6 차원 벡터 (joy, sadness, anger, fear, calm, excitement) 가 아직 선언돼 있지 않다면 본 사이클에서 신규 도입.
- VTuberEmitter 는 현재 rule-based 표정 선택 (phrase → expression). PR-X3-9 에서 mood 기반으로 대체.

## 5. Session lifecycle 와의 관계 (X2 완결 덕)

X2 에서 다음이 이미 준비됨:

- `SessionLifecycleBus` — SESSION_CREATED / RESTORED / IDLE / REVIVED / ABANDONED 이벤트 발행.
- `TickEngine` — interval + jitter spec 으로 주기 handler 구동.
- `idle_monitor` / `thinking_trigger` / `ws_abandoned_detector` — 3 spec 이 이미 engine 에 등록되어 상시 구동.

X3 에서 추가되는 것:

- `DecayPolicy` 를 TickEngine 에 `decay_all_characters` 스펙으로 등록 (15 min).
- SESSION_CREATED / RESTORED 시 hydrate trigger (agent_session.run_turn 진입 시).
- SESSION_ABANDONED 는 당장 state 에 아무것도 하지 않음 (미래 penalty 도입 여지만 남김).

## 6. 결론

- 기존 character / session / persona 계통과 분리된 새 테이블과 service 트리.
- Mood 만 기존 감정 추출과 공유 소지 — 실 구현 시 재확인.
- 모든 변경이 **게임 기능 옵트인** 경로 (feature flag) 에 들어가 비-게임 세션은 영향 없음.
