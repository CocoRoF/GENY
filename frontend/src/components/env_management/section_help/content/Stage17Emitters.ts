/**
 * Help content for Stage 17 → Emitters chain.
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Emitters chain',
  summary:
    "How the agent's output is delivered to consumers — UI text streams, websocket callbacks, VTuber emotion updates, TTS audio. The chain runs top-to-bottom every turn; each emitter reads `state.final_text` (and other state fields) and pushes to its destination.",
  whatItDoes: `Stage 17 sits between Stage 16 (loop decision) and Stage 18 (memory). By the time Stage 17 runs, \`state.final_text\` is the assistant's response for this turn (or a tool-use turn's empty string).

Each emitter is **side-effect-only**: it reads state, calls a host-attached callback (or skips silently if no callback is wired), and emits an event. They don't mutate state directly — except \`vtuber\` which writes \`state.metadata["last_emotion"]\`.

**The chain is empty by default.** Callbacks must be attached at runtime via \`Pipeline.attach_runtime(text_callback=..., tts_callback=..., emotion_callback=...)\`. Manifest can name emitters but the host must wire the actual delivery functions.

**Order matters when:**

- text emission should precede TTS (so the user sees text before they hear it)
- VTuber emotion updates should precede the audio so avatar emotion matches the speech`,
  options: [
    {
      id: 'text',
      label: 'Text',
      description: `Emit \`state.final_text\` to a host-attached text callback. Cheapest emitter — just a function call with the response string.

Used by chat UIs that want to stream / display the response, web apps that need to push to a WebSocket, etc.`,
      bestFor: [
        'Chat UI pipelines — text emitter is the bridge from agent to user',
        'API endpoints — text callback collects responses for the HTTP reply',
        'Default for most pipelines',
      ],
      avoidWhen: [
        'You don\'t have a text callback to attach — picking text is a no-op',
        'Pipelines emitting only structured output (no human-facing text) — `state.final_text` may be empty',
      ],
      gotchas: [
        'Tool-use-only turns produce empty `state.final_text`. The text emitter still fires (with empty string) — the callback should handle empties gracefully.',
      ],
      codeRef:
        'geny-executor / s17_emit/artifact/default/emitters.py:TextEmitter',
    },
    {
      id: 'callback',
      label: 'Callback',
      description: `Generic callback with full state access. The most flexible emitter — the callback can do anything (log to file, push to a queue, update a dashboard, etc.) given the entire \`PipelineState\`.

Use when the simpler emitters don't fit your delivery shape — e.g., you need both text AND structured output AND token usage in a single payload.`,
      bestFor: [
        'Custom delivery — host wants the full state, not pre-shaped',
        'Analytics / logging — full state captures more than text alone',
        'Pipelines integrating with non-standard channels',
      ],
      avoidWhen: [
        'Standard text streaming — `text` is simpler and matches typical chat UIs',
      ],
      codeRef:
        'geny-executor / s17_emit/artifact/default/emitters.py:CallbackEmitter',
    },
    {
      id: 'vtuber',
      label: 'VTuber',
      description: `Extracts emotion (string keyword) from the response and pushes to a host-attached emotion callback. Writes the detected emotion to \`state.metadata["last_emotion"]\` for downstream consumers.

Used by avatar / live2d pipelines where the visual character must match the response sentiment.`,
      bestFor: [
        'VTuber / avatar pipelines',
        'Game NPC dialogue with emoting characters',
        'Any pipeline where response mood must drive a visual',
      ],
      avoidWhen: [
        'Plain text agents — emotion extraction adds latency for no visible benefit',
      ],
      gotchas: [
        'Emotion extraction is regex-based on tagged text (`<emotion>happy</emotion>` style). If the model doesn\'t emit those tags, the emitter\'s extracted emotion is empty.',
        'Writes to `state.metadata["last_emotion"]` — Stage 18 (Memory) and Stage 20 (Persist) snapshots include this if you\'re tracking emotional state across turns.',
      ],
      codeRef:
        'geny-executor / s17_emit/artifact/default/emitters.py:VTuberEmitter',
    },
    {
      id: 'tts',
      label: 'TTS',
      description: `Sends \`state.final_text\` (with optional emotion / voice metadata) to a host-attached TTS callback. The callback handles synthesis — Stage 17 just delivers the request.

Like VTuber, the TTS callback is host-side. Manifest declares "I want TTS"; host installs the actual TTS provider (ElevenLabs, OpenAI TTS, on-device, etc.).`,
      bestFor: [
        'Voice chat pipelines',
        'VTuber pipelines (pair with vtuber emitter for emotion-aware speech)',
        'Accessibility — text agents augmented with audio',
      ],
      avoidWhen: [
        'You don\'t have a TTS callback wired — picks emit silently',
      ],
      gotchas: [
        'TTS latency is on the critical path. Place the TTS emitter AFTER text emitter so users see the text immediately and hear audio when ready.',
      ],
      codeRef:
        'geny-executor / s17_emit/artifact/default/emitters.py:TTSEmitter',
    },
  ],
  relatedSections: [
    {
      label: 'Stage 21 — Yield (formatter)',
      body: 'Stage 21 produces `state.final_output` (potentially structured). Stage 17 emits before Stage 21\'s formatter runs — so emitters see `state.final_text` but not yet the formatted output.',
    },
    {
      label: 'Stage 18 — Memory',
      body: 'Stage 18 captures `state.metadata["last_emotion"]` if the vtuber emitter wrote one — useful for memory recall ("we were happy in this conversation last time").',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s17_emit/artifact/default/emitters.py',
};

const ko: SectionHelpContent = {
  title: '이미터 체인 (Emitters chain)',
  summary:
    '에이전트의 출력이 소비자에게 어떻게 전달될지 — UI 텍스트 스트림, websocket 콜백, VTuber 감정 업데이트, TTS 오디오. 체인이 매 턴 위에서 아래로 실행; 각 이미터가 \`state.final_text\` (및 다른 state 필드) 를 읽고 자신의 destination 으로 push.',
  whatItDoes: `17단계는 16단계 (루프 결정) 와 18단계 (메모리) 사이에 위치. 17단계 실행 시점에 \`state.final_text\` 는 이번 턴의 어시스턴트 응답 (또는 tool-use 턴의 빈 문자열).

각 emitter 는 **side-effect-only**: state 읽고, 호스트 attach 된 callback 호출 (또는 callback 이 wire 안 됐으면 silent 하게 skip), 이벤트 emit. 직접 state 변경 안 함 — \`vtuber\` 만 \`state.metadata["last_emotion"]\` 씀.

**체인은 기본적으로 비어있음.** Callback 은 런타임에 \`Pipeline.attach_runtime(text_callback=..., tts_callback=..., emotion_callback=...)\` 로 attach 되어야 함. 매니페스트가 emitter 명명 가능하지만 호스트가 실제 전달 함수 wire 해야 함.

**순서가 중요할 때:**

- TTS 전에 텍스트 emission 이 와야 함 (사용자가 듣기 전에 텍스트를 봄)
- VTuber 감정 업데이트가 오디오 전에 와야 함 (아바타 감정이 speech 와 매칭)`,
  options: [
    {
      id: 'text',
      label: '텍스트 (Text)',
      description: `\`state.final_text\` 를 호스트 attach 된 text callback 으로 emit. 가장 싼 emitter — 응답 문자열로 단지 함수 호출.

응답을 stream / 표시하는 채팅 UI, WebSocket 으로 push 해야 하는 웹 앱 등에서 사용.`,
      bestFor: [
        '채팅 UI 파이프라인 — text emitter 가 에이전트에서 사용자로의 다리',
        'API 엔드포인트 — text callback 이 HTTP 응답용 응답 수집',
        '대부분 파이프라인의 기본값',
      ],
      avoidWhen: [
        'attach 할 text callback 없을 때 — text 선택은 no-op',
        '구조화 출력만 emit 하는 파이프라인 (사람 대면 텍스트 없음) — `state.final_text` 가 비어있을 수 있음',
      ],
      gotchas: [
        'Tool-use-only 턴은 빈 `state.final_text` 생산. text emitter 가 여전히 발화 (빈 문자열로) — callback 이 빈 것 graceful 하게 처리해야 함.',
      ],
      codeRef:
        'geny-executor / s17_emit/artifact/default/emitters.py:TextEmitter',
    },
    {
      id: 'callback',
      label: '콜백 (Callback)',
      description: `state 전체 접근 가능한 범용 callback. 가장 유연한 emitter — callback 이 전체 \`PipelineState\` 가 주어지면 무엇이든 가능 (파일 로그, 큐 push, 대시보드 업데이트 등).

더 단순한 emitter 가 전달 모양에 안 맞을 때 사용 — 예: 단일 페이로드에 텍스트 AND 구조화 출력 AND 토큰 사용량 모두 필요.`,
      bestFor: [
        '커스텀 전달 — 호스트가 사전 모양된 게 아닌 전체 state 원함',
        '분석 / 로깅 — 전체 state 가 텍스트만보다 더 많이 캡처',
        '비표준 채널과 통합하는 파이프라인',
      ],
      avoidWhen: [
        '표준 텍스트 스트리밍 — `text` 가 더 단순하고 일반 채팅 UI 매칭',
      ],
      codeRef:
        'geny-executor / s17_emit/artifact/default/emitters.py:CallbackEmitter',
    },
    {
      id: 'vtuber',
      label: 'VTuber',
      description: `응답에서 감정 (문자열 키워드) 추출하고 호스트 attach 된 감정 callback 으로 push. 감지된 감정을 하류 소비자용 \`state.metadata["last_emotion"]\` 에 씀.

비주얼 캐릭터가 응답 sentiment 매칭해야 하는 아바타 / live2d 파이프라인에 사용.`,
      bestFor: [
        'VTuber / 아바타 파이프라인',
        '감정 표현 캐릭터의 게임 NPC 대화',
        '응답 분위기가 비주얼을 driving 해야 하는 모든 파이프라인',
      ],
      avoidWhen: [
        '평문 텍스트 에이전트 — 감정 추출이 가시 이익 없이 latency 추가',
      ],
      gotchas: [
        '감정 추출은 태그된 텍스트 (`<emotion>happy</emotion>` 스타일) 의 regex 기반. 모델이 그 태그를 emit 안 하면 emitter 의 추출된 감정은 비어있음.',
        '`state.metadata["last_emotion"]` 에 씀 — 턴 간 감정 state 추적하면 18단계 (메모리) 와 20단계 (Persist) 스냅샷이 이를 포함.',
      ],
      codeRef:
        'geny-executor / s17_emit/artifact/default/emitters.py:VTuberEmitter',
    },
    {
      id: 'tts',
      label: 'TTS',
      description: `\`state.final_text\` (선택적 감정 / 보이스 메타데이터와 함께) 를 호스트 attach 된 TTS callback 으로 보냄. Callback 이 합성 처리 — 17단계는 단지 요청 전달.

VTuber 처럼 TTS callback 은 호스트 측. 매니페스트가 "TTS 원함" 선언; 호스트가 실제 TTS provider (ElevenLabs, OpenAI TTS, on-device 등) 설치.`,
      bestFor: [
        '보이스 채팅 파이프라인',
        'VTuber 파이프라인 (감정 인식 speech 위해 vtuber emitter 와 짝)',
        '접근성 — 오디오로 augmented 된 텍스트 에이전트',
      ],
      avoidWhen: [
        'TTS callback 이 wire 안 됐을 때 — 픽이 silent 하게 emit',
      ],
      gotchas: [
        'TTS latency 가 critical path 위에 있음. text emitter 후에 TTS emitter 배치 — 사용자가 텍스트 즉시 보고 준비되면 오디오 들음.',
      ],
      codeRef:
        'geny-executor / s17_emit/artifact/default/emitters.py:TTSEmitter',
    },
  ],
  relatedSections: [
    {
      label: '21단계 — Yield (formatter)',
      body: '21단계가 `state.final_output` 생산 (잠재적으로 구조화). 17단계는 21단계의 formatter 실행 전에 emit — 따라서 emitter 들은 `state.final_text` 보지만 아직 포맷된 출력은 안 봄.',
    },
    {
      label: '18단계 — Memory',
      body: 'vtuber emitter 가 썼다면 18단계가 `state.metadata["last_emotion"]` 캡처 — 메모리 recall 에 유용 ("지난 번에 이 대화에서 행복했어").',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s17_emit/artifact/default/emitters.py',
};

export const stage17EmittersHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
