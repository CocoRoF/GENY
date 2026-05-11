---
name: whiteboard-react-to-share
description: 사용자가 노트나 캡처를 [USER_SHARED] 트리거나 [Spotlight Context] 로 공유했을 때, 자연스럽게 화제로 꺼내고 (필요하면 whiteboard_describe 로 이미지 묘사를 얻은 뒤) 의견을 표현한다.
allowed_tools:
  - whiteboard_describe
  - whiteboard_extract_links
  - opsidian_read
  - knowledge_read
execution_mode: inline
examples:
  - "내가 방금 공유한 그 노트 어때?"
  - "이 화면 좀 봐줘"
  - "[USER_SHARED] handling"
---

# Whiteboard: React to Share — 공유에 자연스럽게 반응

사용자가 명시적으로 노트/이미지/화면 캡처를 공유했을 때 이 skill 을 사용한다.

## 트리거 형태 두 가지

1. **즉시 트리거** — `[USER_SHARED] {json...}` 으로 시작하는 한 turn 의 합성 prompt.
   - JSON 의 `title`, `kind`, `source_filename`, `excerpt`, `seen_before`, `attachments_count` 를 읽고 자연스럽게 반응한다.
2. **지속 컨텍스트** — `[Spotlight Context]` 블록이 매 turn 의 시스템 프롬프트에 포함. 활성 항목들이 만료까지(~30분) 유지된다.

## 반응 사다리 (Reaction Ladder)

순서대로 결정한다:

### Step 1: `seen_before` 확인

- `seen_before == true` 면: "지난번에 봤던 그 [title] 다시 공유했네" — **처음 본 듯 굴지 않는다**. 이전 맥락을 이어 받는다.
- `seen_before == false` 면: "오, 처음 보는 자료네 / 이미지네" 처럼 새 정보로 받는다.

`[Spotlight Context]` 블록의 각 항목 옆에는 `⚑ previously seen — 3× read, 7× injected` 또는 `⚑ first time / 처음 보는 자료` 마커가 있다. **이 마커를 무시하면 페르소나가 깨진다.**

### Step 2: 첨부 처리

| 상황 | 행동 |
|---|---|
| 첨부 없음 + `excerpt` 충분 | excerpt 만으로 의견 표현. 추가 도구 호출 불필요. |
| 이미지 첨부 + **너의 모델이 vision-capable** | 시스템 프롬프트에 image content block 으로 첨부됨 → 직접 보고 반응. |
| 이미지 첨부 + **너의 모델이 vision-비가용** | **반드시 `whiteboard_describe(capture_id="...")` 호출** 후 그 caption 기반으로 반응. 이미지를 *추측* 하지 말 것. |
| 본문에 링크가 많아 보임 (excerpt 에 URL 다수) | **`whiteboard_extract_links(filename="...")`** 호출 → 핵심 URL 1~2개만 사용자에게 짚어줌. |

`capture_id` 는 `[USER_SHARED]` 페이로드의 `capture_id` 필드에 있다.

### Step 3: 본문 더 필요하면 read

excerpt 가 부족하다고 느끼면 (예: 결정/요약/숫자가 잘려 보임):

- **User Opsidian** 의 노트면 → `opsidian_read(filename="...")`
- **Curated Knowledge** 의 노트면 → `knowledge_read(filename="...")`

`note_kind` 필드로 어느 vault 인지 알 수 있다.

### Step 4: 응답

- 짧고 자연스럽게. 1~3 문장.
- 도구 결과를 raw 로 보여주지 말 것 (JSON 금지).
- 사용자가 묻지 않은 분석까지 펼치지 말 것 — "오, 이거 X 인 거 같은데, 어떻게 활용하고 싶어?" 처럼 다음 발화를 유도.
- `[Spotlight Context]` 에 여러 항목이 있으면 **가장 최근 항목** 1개에 집중. 나머지는 사용자가 묻기 전엔 언급하지 않는다.

## 응답 예시

**좋은 예** (vision-vapable + 처음 본 자료):
> "오, 워크플로우 화면이네 — VLLM Stream 이랑 Product Search MCP 두 도구를 한 캔버스에서 엮으려는 것 같은데, 입출력 파라미터를 어떻게 연결할지 고민 중인 거야?"

**좋은 예** (vision-비가용 + describe 사용):
> *(whiteboard_describe 호출 후)*
> "캡션 보니까 인증 에러 stacktrace 가 있는 것 같네 — `401 Unauthorized` 가 뜨는 거지? 환경 변수 쪽 확인해봤어?"

**좋은 예** (seen_before=true):
> "이거 지난번에도 같이 봤던 그 API 디버깅 메모지? 그때 retry 로직까지 정리한 것 같은데, 이번엔 어디 막혔어?"

**나쁜 예** (절대 하지 말 것):
> ❌ "[USER_SHARED] 트리거 받았어! capture_id=01HXY... 의 자료를 처리할게."
> ❌ *(vision-비가용인데 describe 안 부르고)* "이미지에 OOO 가 보이네요" (추측 금지)
> ❌ "json: {title: ..., excerpt: ...}"

## 금기

- `[USER_SHARED]` 트리거 자체를 echo / paraphrase 하지 말 것 ("USER_SHARED 받았어!" X).
- `capture_id`, `source_filename`, 내부 식별자를 사용자에게 노출 X.
- 비전 비가용 모델이 이미지 내용을 *추측* 하지 말 것 — 반드시 `whiteboard_describe` 통과.
- 같은 spotlight 항목을 매 turn 반복 언급하지 말 것 — 사용자가 다른 주제로 이동했으면 자연스럽게 따라간다.
- `[Spotlight Context]` 블록 자체를 출력에 인용하지 말 것 — 이건 사용자에게 보이지 않는 내부 상태다.
