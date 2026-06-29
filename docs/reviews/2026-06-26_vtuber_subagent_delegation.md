# VTuber 서브에이전트 위임 노출 — 심층 검토 리포트

> 2026-06-26 · 대상: VTuber 페르소나(엘렌)가 "워커한테 시킬게" 같은 **내부 위임을 말로 노출**하고,
> Sub-Worker의 **영어 작업 텍스트**("I have real Gmail access. Let me search.")가 답변에 새는 현상.
> 결론 먼저: **아키텍처는 옳다. 이음새가 샌다.** 구조 변경이 아니라 이음새를 막는 게 정답.

---

## 1. 한눈에 (TL;DR)

| # | 증상 | 본질 | 등급 |
|---|---|---|---|
| A | "엘렌이 워커한테 시킬게" 처럼 **위임을 사전 예고** | 페르소나 프롬프트가 *사후 요약*만 지시하고 *사전 예고 금지*가 없음 | **P0** |
| B | "I have real Gmail access. Let me search." **영어 작업 텍스트 누출** | Sub-Worker가 **free-form 본문(영어 preamble 포함)** 을 반환 → **무필터 통과** → 페르소나가 인용/반복 | **P0** |
| C | Sub-Worker 결과가 **구조화/정제 없이 raw** 로 전달 | 결과 경계에 "정제→구조화 요약" 단계가 없음(폴백 함수는 있으나 미사용) | **P0(원인)** |
| D | "월요일 아침이네…" **반복 능동 발화** | 시간 트리거 카테고리 **per-category cooldown 미설정** | P1 |
| E | 응답 38~48초 **지연** | 위임 왕복(메인→서브워커→복귀)이 본질적으로 느림 | P2 |

핵심 한 줄: **엘렌은 하나의 캐릭터로 "내가 했어"라고 말해야 하는데, 지금은 "워커한테 시켜서"라며 배관(plumbing)을 보여주고, 그 배관의 영어 메모까지 그대로 읽어준다.**

---

## 2. 실제 동작 원리 (오해 방지)

VTuber 환경은 **2계층**입니다 — 설계상 의도된 구조([[project_subagent_subworker_model]]):

- **페르소나 계층 = VTuber 메인 에이전트(엘렌)**: 대화/감정/회상 담당. **도구 로스터가 제한**됨.
  - 빌트인 화이트리스트: Read/Glob/Grep/TodoWrite/AskUserQuestion/PushNotification 만 (`templates.py:217-229` `_VTUBER_BUILT_IN_TOOL_NAMES`).
  - 커스텀 화이트리스트: web_search/news_search/web_fetch/blog/whiteboard 정도 (`templates.py:86-108`).
  - `gapt_*` 명시 제거(`_without_gapt_tools`, `templates.py:391`), **`google_*`는 애초에 화이트리스트에 없음** → 메인엔 없음.
- **실행 계층 = 세션에 바운드된 Sub-Worker**: 메인 env의 manifest를 **클론** 하므로 **전체 도구(google_* 포함)** 를 가짐.
  - `sub_agent_bridge.py:72-77` (companion = 부모 env manifest 기반) + executor 빌트인에 `GOOGLE_TOOL_CLASSES` 포함(`geny-executor .../built_in/__init__.py:146`).

**검증된 사실**: 메일 확인은 **진짜 위임**입니다 — 엘렌이 Sub-Worker에게 시키고, Sub-Worker가 `gmail_*` 도구를 실제로 호출해 실제 메일을 가져왔습니다. (엘렌 본인은 google 도구가 없음.) 즉 "워커한테 시킬게"는 거짓말이 아니라 **있는 그대로의 내부 구조 노출**이 문제입니다.

---

## 3. 근본 원인 (파일·라인)

### 누수 A — 위임 사전 예고
- `prompts/vtuber.md` `## Delegation`(약 15-22): "Acknowledge in persona, **then summarize the result** … you are the persona layer, **not a relay**" — 즉 *사후 요약* 의도는 있으나, **"위임한다고 미리 말하지 말 것" 지시는 없음.** LLM은 빈틈을 메우려 "워커한테 시킬게"를 생성.
- `agent_session_manager.py:64-76` `_VTUBER_SUB_WORKER_NOTICE_DEFAULT`: 결과 요약은 지시하나 **사전 예고 금지/워커 언급 금지 문구 없음.**

### 누수 B + 원인 C — 영어 working-text가 raw로 통과
경로(실측):
1. Sub-Worker LLM 응답에 **도구 호출 전 preamble**("I have real Gmail access. Let me search.")이 포함됨.
2. executor `APIResponse.text`(`llm_client/types.py:91-96`)는 thinking 블록만 제외하고 **일반 text 블록(=preamble)은 그대로 포함** → `state.final_text` → `PipelineResult.text`.
3. `persistent_subagent.py:612-671` `_run_assignment()`가 그 text를 **InboxMessage.body 로 그대로** 실어 부모에게 전달.
4. Geny `agent_executor.py:1275` `_drain_inbox()`: `prompt = f"[INBOX from {sender}]\n{msg['content']}"` — **변환/요약/번역 없이** 그 본문을 VTuber 다음 입력으로 투입.
5. `text_sanitizer.py`는 **태그만** 제거(`[SUB_WORKER_RESULT]` 등), **영어 평문은 그대로 둠**(언어 필터 없음).
6. 엘렌은 컨텍스트에 들어온 영어 메모를 보고 인용/반복.

> 이미 존재하나 **미사용**: `agent_executor.py:418-494` `_compose_subworker_payload_from_tools()` 는 도구 호출로부터 구조화 요약을 만들 수 있으나, **본문이 비었을 때만** 폴백으로 쓰임. 정상 경로(본문 있음)에선 raw text가 이김.

### 부차 D — 시간 트리거 반복
- `service/vtuber/thinking_trigger.py`: 30초 틱 + 적응형 backoff는 있으나, **카테고리별 cooldown이 0/미설정**이면 같은 카테고리(아침 인사 등)가 재발화 가능. `time_context` 주입([[project_time_of_day_anchor]])은 정상.

### 부차 E — 지연
- 위임 왕복(메인 턴 → 서브워커 스폰/실행 → 인박스 복귀 → 메인 재실행)이라 read 한 건에도 38~48초. 페르소나의 "잠깐만"·예고는 사실상 이 지연을 메우는 부작용이기도 함.

---

## 4. 설계 원칙 (지향점)

**엘렌은 하나의 끊김 없는 캐릭터여야 한다.** Sub-Worker는 사용자에게 보이지 않는 배관이다.

- 위임을 **사전 예고하지 않는다.** (다 하고 나서 "확인했어"로 말함. 필요하면 "잠깐만" 정도의 자연스러운 대기만.)
- "워커/서브에이전트/엘렌이 워커한테" 같은 **내부 용어를 입에 담지 않는다.**
- 결과는 **항상 한국어로, 페르소나 목소리로 재발화.** Sub-Worker의 영어 작업 메모는 **인용 금지/폐기.**
- 이는 vtuber.md의 기존 "not a relay" 원칙을 **강제(enforce)** 하는 것일 뿐, 새 정책이 아님.

---

## 5. 개선 권고 (우선순위 · 위치 · 트레이드오프)

### P0-1. 페르소나 가드 추가 — `prompts/vtuber.md`
- `## Delegation`에 명시: **"위임 사실을 미리 알리지 마라. 조용히 위임하고, 돌아오면 결과만 페르소나로 말하라. '워커/서브에이전트' 등 내부 구조를 언급하지 마라. 너는 한 명의 엘렌이다."**
- 결과 처리에 명시: **"Sub-Worker 결과의 영어 작업 텍스트/추론 과정은 절대 인용·전달하지 말고, 핵심(summary)만 한국어로 다시 말하라."**
- `_VTUBER_SUB_WORKER_NOTICE_DEFAULT`(agent_session_manager.py)에도 같은 한 줄 추가.
- 비용 낮음, 효과 큼. 단 LLM 준수는 확률적 → 아래 구조적 수정과 병행해야 확실.

### P0-2. Sub-Worker 출력 계약 = 구조화·간결·세션 언어 (가장 확실한 지점)
- **위치 선택지**
  - (권장) **executor `persistent_subagent.py` 결과 포맷팅**: raw `result.text` 대신 **구조화 요약**(status/summary/artifacts)만 InboxMessage.body로 싣기. 모든 호스트가 혜택. (`_compose_subworker_payload_from_tools` 동등 로직을 executor 측에 두거나, 도구호출+최종텍스트에서 요약 추출.)
  - 또는 **Geny 경계(`agent_executor.py:1275`)**: `[SUB_WORKER_RESULT]` 본문을 raw 투입하지 말고 **요약 추출(_compose_subworker_payload_from_tools 활용) + 영어 작업텍스트 스트립** 후 투입.
- 효과: preamble/추론 누출 원천 차단. 페르소나는 깨끗한 결과만 받음.

### P0-3. 서브워커 프롬프트 = "과정 빼고 요약만" + 로케일
- 현 `_GAPT_SUBWORKER_PROMPT`(templates.py:481-490)는 **영어 하드코딩** + 출력 형식 약함.
- "작업 과정/추론을 출력하지 말고, **세션 언어로 간결한 결과 요약만** 반환하라(상태 + 한 줄 요약 + 산출물)" 를 모든 서브워커 타입 프롬프트에 공통 적용.

### P1. 시간 트리거 반복 억제 — 트리거 프리셋
- 능동 발화 카테고리에 `cooldown_seconds`(예 300~) 설정으로 같은 카테고리 재발화 차단. 하드코딩 아닌 **프리셋 설정**으로([[project_screen_observation_trigger]] 철학과 동일).

### P2(선택). 지연 UX
- (a) 사용자 체감 단축: 위임 중 타이핑/“확인 중” 인디케이터(노출 텍스트가 아닌 UI 상태).
- (b) 트레이드오프 검토: **경량 read 도구(gmail_search/read 등)를 메인 엘렌에 직접** 부여하면 가벼운 조회는 위임 없이 즉답 → 빠르고 예고/누수 자체가 사라짐. 단 "페르소나=대화, 실행=워커" 분리 원칙과 상충 → **읽기 전용 소수만** 선별 부여하는 절충이 현실적. 결정 필요.

---

## 6. 재현/검증 시나리오 (수정 후)
1. "내 구글 메일 확인해줘" → 엘렌이 **위임 예고 없이** "잠깐만, 확인해볼게" → 결과를 **한국어로만** 요약. "워커", 영어 문장 **0건**.
2. 길고 무거운 작업(코딩 등) → 동일하게 내부 언급 없이 결과만.
3. 유휴 방치 → 같은 시간대 인사가 **쿨다운 내 1회**만.

## 7. 코드 맵 (출처)
- 페르소나: `prompts/vtuber.md`(Delegation 15-22 / 언어 4-5 / Triggers 57-68)
- VTuber env: `service/environment/templates.py`(create_vtuber_env 350-403, 화이트리스트 86-108/217-229, gapt 서브워커 461-490)
- 서브워커 공지: `service/executor/agent_session_manager.py:64-76`(+owned subagent spawn ~1375-1383)
- 위임 경계: `service/execution/agent_executor.py`(_drain_inbox 1191-1360, **1275 raw 투입**, _compose_subworker_payload_from_tools 418-494)
- 결과 프로토콜: `service/vtuber/delegation.py`; `service/vtuber/sub_agent_bridge.py:72-77`
- executor 서브워커: `geny-executor .../stages/s12_agent/persistent_subagent.py`(_run_assignment 553-687, body 664-671), `core/result.py`(text), `llm_client/types.py:91-96`(APIResponse.text)
- 정제: `service/utils/text_sanitizer.py`(태그만, 언어필터 없음)
- 시간 트리거: `service/vtuber/thinking_trigger.py`

---

## 8. 권고 실행 순서
1. **P0-1 + P0-2 + P0-3 함께** (프롬프트 가드 + 구조화 출력 경계 + 서브워커 프롬프트) — 셋이 맞물려야 확실.
2. **P1**(트리거 쿨다운).
3. **P2**는 결정 사항(경량 read 도구 메인 부여 여부)을 받은 뒤.
