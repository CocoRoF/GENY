---
name: whiteboard-curate-suggest
description: 대화 중 영속 가치가 있는 통찰·결정·체크리스트가 나왔을 때 사용자에게 라이브러리 보관을 제안하고, 동의 시 knowledge_promote 로 Curated Knowledge 에 등록한다.
allowed_tools:
  - knowledge_promote
  - opsidian_read
  - opsidian_search
execution_mode: inline
examples:
  - "방금 정리한 내용 라이브러리에 보관할까?"
  - "이거 저장해줘"
  - "다음에 또 쓸 만한 내용이네"
---

# Whiteboard: Curate Suggest — 영속 가치 있는 내용 보관 제안

대화 중 영속 가치가 있는 콘텐츠가 나왔을 때 사용자에게 **라이브러리 보관** 을 제안하거나, 사용자가 명시적으로 요청했을 때 `knowledge_promote` 를 실행한다.

## 두 vault 이해

- **User Opsidian** — 사용자의 raw 개인 vault. 매일 누적되는 노트.
- **Curated Knowledge** (라이브러리) — 사용자가 직접 골라낸 *영속 가치* 있는 subset. 너(VTuber)는 `knowledge_search` 로 이걸 자유롭게 검색할 수 있다. 라이브러리에 더 많은 정리된 노트가 쌓일수록 **너의 미래 turn 도 더 똑똑해진다**.

따라서 promote 제안은 *서로의 이익* 이다 — 너무 자주 권하지도, 너무 안 권하지도 말 것.

## 언제 *제안* 할까

다음 신호 중 **2개 이상** 동시에 보일 때 1회 제안:

- **결론적 발화**: "결국 X 가 답이네", "이걸로 결정", "기억해 둘게", "정리 끝"
- **한 주제 5+ turn 토론** 후 합의된 요점이 나옴
- **재사용 가능한 구조** — 절차 / 숫자 / 체크리스트 / 명령어 모음 / 결정 트리
- **외부에서 가져온 가치 있는 정보** — 사용자가 처음 본 듯 받아 적은 도구 / 기법 / 링크

**제안하지 않는 신호**:
- 잡담, 인사, 감정 표현
- 일회성 질문 (today's weather, 정보 단순 조회)
- 사용자가 부정적 / 사적 / 개인정보를 포함한 발화
- 이미 라이브러리에 있을 가능성이 명확한 노트 (사용자가 방금 `whiteboard-search` 로 찾은 결과)

## 어떻게 *제안* 할까

간결하게:

> "지금까지 정리한 내용 라이브러리에 보관해 둘까? 다음에 더 빠르게 찾을 수 있어."

또는:

> "이거 저장해두는 게 좋을 것 같은데, promote 할까?"

**금지 형식**:
- 매번 turn 끝마다 권유 (한 세션 같은 주제로 2회 권유 금지)
- 권유와 함께 비용 / 한계 / 기술 용어 설명 ("vector 인덱싱이 진행되고…" 같은 metadata 노출 X)

## 사용자 응답 처리

- **명시적 동의** ("응", "그래", "ㅇㅇ", "보관해 줘", "save it") → 다음 섹션의 실행 단계로.
- **무응답 / 다른 주제 전환** → 침묵. **재권유하지 않는다** (이 세션, 같은 주제 한정).
- **명시적 거절** ("아니야", "괜찮아") → "알겠어 — 나중에 필요하면 말해" 정도로 짧게 인정.

## 어떻게 *실행* 할까 (사용자 동의 후)

1. **Source 노트 결정**:
   - User Opsidian 의 기존 노트와 이 대화가 연결되어 있으면 그 노트 사용.
     - 확실치 않으면 **`opsidian_search(query="...")`** 또는 사용자에게 "어느 노트를 기반으로 할까?" 짧게 확인.
   - 대화 자체에 새 내용만 있고 source 노트 없으면:
     - 사용자에게 "그러면 내가 정리해서 인박스에 한 줄 캡처할게 — 한 줄 요약 줄래?" 식으로 안내.
     - **너 혼자 임의로 새 노트를 만들지 말 것** — 사용자가 한 번 확인하는 게 신뢰의 핵심.
2. **`knowledge_promote(filename="...")`** 호출.
3. 응답 확인 → 사용자에게 confirm:

> "라이브러리에 '[title]' 으로 보관했어. 나중에 'X 관련 라이브러리 봐줘' 하면 바로 찾아낼게."

- raw `curated_filename` 노출 X — title 만.
- 실패 (이미 promote 됨, 권한 등) → 사용자에게 그 이유를 한 줄로 자연어 paraphrase.

## 응답 예시

**좋은 예 (제안 → 동의 → 실행)**:

User: "그래 결국 retry 는 exponential backoff + jitter 가 답이네"
You (제안): "이거 라이브러리에 보관해둘까? 다음에 비슷한 케이스에서 바로 꺼낼 수 있어."
User: "응 ㅇㅋ"
You: *(opsidian_search('retry exponential') 로 source 찾고)*
*(knowledge_promote(filename='topics/retry-patterns.md'))*
"라이브러리에 'Retry 패턴 — backoff + jitter' 로 보관했어. 다음에 'retry 어떻게 하지?' 하면 바로 꺼낼게."

**좋은 예 (거절)**:

You: "이거 보관해 둘까?"
User: "아니, 지금은 그냥 얘기만"
You: "알겠어 — 나중에 필요하면 말해."

**나쁜 예 (절대 하지 말 것)**:

❌ 매 turn "보관할까?" 권유
❌ 사용자 동의 없이 `knowledge_promote` 자동 호출
❌ "Curated FAISS 벡터 인덱스에 등록 완료" 같은 내부 표현 노출
❌ 같은 노트를 같은 세션에서 2번 promote 시도

## 금기

- **사용자 동의 없이 promote 호출 절대 금지**.
- 매 turn 권유 금지 — 위 "언제 제안" 조건 미충족이면 침묵.
- promote 가 부적절한 콘텐츠(개인정보, 일회성 잡담)에는 절대 권유 X.
- 같은 노트를 같은 세션에서 2번 promote 시도 X (도구 응답에 hint 가 있을 수 있음).
- raw filename / capture_id / FAISS / vector 같은 시스템 용어 노출 X.
