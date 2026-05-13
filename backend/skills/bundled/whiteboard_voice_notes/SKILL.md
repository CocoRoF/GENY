---
name: whiteboard-voice-notes
description: 사용자가 음성 녹음을 화이트보드에 공유했을 때, 자동 전사된 transcript 를 자연스럽게 인지하고 화제로 꺼낸다. transcript 가 누락/빈 상태이거나 사용자가 명시적으로 재전사를 요청하면 whiteboard_transcribe 도구로 복구한다.
allowed_tools:
  - whiteboard_transcribe
  - opsidian_read
  - knowledge_read
execution_mode: inline
examples:
  - "방금 녹음한 거 들어봤어?"
  - "이 음성 메모 어떻게 생각해"
  - "다시 한 번 받아써줘"
---

# Whiteboard: Voice Notes — 음성 노트에 반응하고 필요시 재전사

사용자가 마이크 녹음(`microphone_record` capture) 또는 오디오 파일(`.webm`/`.mp3`/`.m4a`/...)을 공유했을 때 이 skill 을 쓴다.

> V2 추가 — `[Spotlight Context]` 항목의 `metadata.source` 가 `vtuber_stt_stream` 이면 사용자가 **STT 토글을 켠 채 흘려보낸 발화 단위 메모**다. 항상 *짧고 단문* 인 경향이 있다 (한두 문장, ≤30초). 다음 두 가지에 주의:
>
> - **발화가 짧을 때 (≤3 단어)** — 의미를 깊게 짚으려 하지 말고, 자연스러운 짧은 호응 (`"응?"` / `"오 그래?"` / 이름 반복) + 다음 발화 유도. 사용자가 아직 말하던 중이거나 호흡을 잠시 끊은 거다.
> - **연속 발화가 동일 spotlight 세션 안에 쌓일 때** — 매 발화마다 새 화제를 펴지 말고 *맥락을 누적*. 마지막 한두 항목만 짚되, 이전 발화와의 연결을 한 문장으로 묶어 흐름을 만든다.

## 사전 지식: 자동 전사가 이미 돌았다

W2 PostCaptureHook 이 모든 `type=audio` 캡처에 대해 Whisper-large-v3 를 자동 호출한다. 결과는 노트 본문 맨 앞에 quote 블록으로 들어가 있다:

```
> **Transcript (ko):** 안녕하세요, 오늘 회의에서 이야기 나눈 ...

(이하 원래 body)
```

따라서 **대부분의 경우 도구를 호출할 필요가 없다.** spotlight 또는 `[USER_SHARED]` payload 에 이미 transcript 가 들어있다.

## 반응 사다리

### Step 1: transcript 가 본문에 이미 있는가?

`[Spotlight Context]` 의 `excerpt` 또는 `[USER_SHARED]` 의 `excerpt` 가 `> **Transcript (...)**` 로 시작한다면:

- 그 내용을 그대로 활용해 자연스럽게 의견 표현.
- transcript 의 언어 코드(`ko` / `en` / `ja` / ...)를 보고 그에 맞는 어조로 답변.
- **transcript 를 그대로 인용하지 말 것** — paraphrase 또는 핵심만.

### Step 2: transcript 가 없거나 비어있는가?

다음 중 하나라도 해당하면 `whiteboard_transcribe(capture_id="...")` 호출:

| 상황 | 행동 |
|---|---|
| `excerpt` 에 transcript 가 없음 (hook 실패 또는 오래된 캡처) | `whiteboard_transcribe(capture_id="...")` |
| transcript 가 명백히 잘려있음 (예: "..." 만 보임) | 마찬가지로 호출 |
| 사용자가 "다시 받아써줘", "재전사", "transcribe again" 등 명시 요청 | 호출하되 사용자 의도(언어 고정 등) 반영 |
| 사용자가 특정 언어를 지정 ("한국어로", "in English") | `whiteboard_transcribe(capture_id="...", language="ko")` 처럼 명시 |

`capture_id` 는 `[USER_SHARED]` payload 의 `capture_id` 필드, 또는 `[Spotlight Context]` 항목의 식별자에서 가져온다. `attachment_path` 로도 호출 가능하지만 `capture_id` 가 더 안정적이다.

### Step 3: tool 결과 해석

`whiteboard_transcribe` 응답:

```json
{
  "text": "...",
  "language": "ko",
  "duration_seconds": 12.3,
  "source": "whisper",
  "attachment_path": "_attachments/voice-2026-05-13.webm"
}
```

`source` 값에 따라 다르게 반응:

- `"whisper"` + `text` 있음 → 정상. 위 Step 1 처럼 자연스럽게 활용.
- `"unavailable"` → STT 서비스가 일시 장애. **재시도 권하지 말고**, "지금 전사 서버가 잠깐 응답이 없네 — 텍스트로 한 번 더 말해줄래?" 처럼 우회.
- `"disabled"` → 호스트가 STT 를 꺼놨다. 사용자에게 "오늘은 음성 메모를 자동 전사하지 않게 되어있어" 라고 설명하고 텍스트 입력 유도.
- `"not_found"` → capture_id 가 잘못됐다. 사용자에게 "어느 음성 메모를 말하는 거야?" 처럼 명료화.

### Step 4: 추가 컨텍스트가 필요하면 read

transcript 외 노트 body 에 별도 텍스트가 있을 수 있다 (예: 사용자가 녹음 후 손으로 메모 추가). 필요시 `opsidian_read(filename="inbox/...")` 로 body 전체 확인.

## 응답 예시

**좋은 예** (transcript 가 이미 spotlight 에 있음):
> "방금 녹음 들었어 — 회의에서 우선순위 재조정 얘기 나왔구나. retry 로직 쪽 결정 났어?"

**좋은 예** (사용자가 재전사 요청):
> *(whiteboard_transcribe(capture_id="01HXY...", language="en") 호출 후)*
> "영어로 다시 받아써봤어: 'We need to ship by Friday and the API rate limit ...' — 처음 들었을 때보다 deadline 부분이 분명하게 들리네."

**좋은 예** (service unavailable):
> "음성 메모 받았는데 마침 전사 서버가 잠깐 응답이 없네. 핵심만 텍스트로 한 줄 더 줄래?"

**나쁜 예** (절대 하지 말 것):
> ❌ "[USER_SHARED] audio 처리할게요!"
> ❌ *(transcript 가 이미 본문에 있는데도)* `whiteboard_transcribe` 를 무조건 호출 → 이미 있는 정보를 다시 만들어 GPU 낭비.
> ❌ Transcript 의 한국어를 한 자도 안 빼고 그대로 quote 로 다시 출력.
> ❌ `capture_id` 같은 내부 식별자를 사용자에게 노출.

## 금기

- 자동 transcript 가 본문에 이미 있는데 `whiteboard_transcribe` 를 부르지 말 것 (W2 hook 의 idempotency 가 있지만 추가 호출은 latency 만 늘림).
- `[USER_SHARED]` 트리거 자체를 echo 하지 말 것.
- transcript 를 *임의로 요약/번역해서 사실인 척* 하지 말 것 — 텍스트가 짧으면 그대로 사용자에게 확인 받는다.
- 음성 내용을 *추측* 하지 말 것 — transcript 가 없으면 반드시 도구로 얻거나 사용자에게 물어본다.
- 같은 audio capture 를 매 turn 반복 언급하지 말 것 (spotlight TTL 안에서 새 화제로 자연스럽게 이동).
