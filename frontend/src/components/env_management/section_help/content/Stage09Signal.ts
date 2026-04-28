/**
 * Help content for Stage 9 → Signal detector slot.
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Completion signal detector',
  summary:
    "Decides what `state.completion_signal` becomes — `CONTINUE`, `COMPLETE`, `ERROR`, `BLOCKED`, `DELEGATE`, `NONE`. Stage 16's loop controller reads this to decide whether to keep looping.",
  whatItDoes: `Every turn ends with the question "do we keep going?". The signal detector answers it by inspecting what the LLM just produced — the response text, the tool calls, the response itself.

The detector writes two things:

- \`state.completion_signal\` — one of \`CONTINUE\` (loop again), \`COMPLETE\` (done, success), \`ERROR\` (done, failed), \`BLOCKED\` (need human / external action), \`DELEGATE\` (hand off to sub-agent), \`NONE\` (no signal detected; controller decides)
- \`state.completion_detail\` — optional human-readable detail string

Stage 16 (Loop) reads these to apply its termination logic. Stage 4 (Guard) and Stage 14 (Evaluate) may also key off them.`,
  options: [
    {
      id: 'regex',
      label: 'Regex',
      description: `Pattern-matches well-known marker strings in \`final_text\`. The default patterns recognise:

- \`<COMPLETE/>\`, \`[COMPLETE]\`, "Task complete" → \`COMPLETE\`
- \`<ERROR>\`, "I cannot..." → \`ERROR\`
- \`<DELEGATE...>\` → \`DELEGATE\`
- presence of tool_use blocks → \`CONTINUE\`
- otherwise → \`NONE\`

Cheapest detector — substring + small regex. Works fine for pipelines where the agent reliably emits markers (or is prompted to).`,
      bestFor: [
        'Pipelines with carefully prompted agents that emit explicit markers',
        'Tool-using chat agents — the implicit "tool_use → CONTINUE" rule covers most cases',
        'Default for new pipelines',
      ],
      avoidWhen: [
        'Agents that don\'t reliably emit markers — `regex` will mostly return `NONE` and Stage 16\'s controller has to decide',
        'Schema-typed agents emitting structured signals — use `structured` instead',
      ],
      gotchas: [
        'Substring matching means false positives are possible. An agent saying "the [COMPLETE] tag would mean we\'re done" gets parsed as `COMPLETE` even though that was a meta-discussion.',
      ],
      codeRef:
        'geny-executor / s09_parse/artifact/default/signals.py:RegexDetector',
    },
    {
      id: 'structured',
      label: 'Structured',
      description: `Reads the signal from a known field in \`state.last_api_response.structured_output\`. Specifically it looks for \`signal\` and \`detail\` keys at the top level of the structured output.

Pairs naturally with \`structured_output\` parser — the agent returns \`{"signal": "COMPLETE", "detail": "...", "answer": "..."}\` and the detector picks up the signal field.`,
      bestFor: [
        'Pipelines paired with `structured_output` parser — the schema can include signal as a required enum',
        'Workflows where signal logic should be type-checked (schema enforces enum values)',
      ],
      avoidWhen: [
        'You\'re using `default` parser — `structured` detector then has nothing to read and always returns `NONE`',
      ],
      gotchas: [
        '**Requires the `structured_output` parser** to populate `state.last_api_response.structured_output`. Pairing this with the default parser gives a silent always-`NONE`.',
      ],
      codeRef:
        'geny-executor / s09_parse/artifact/default/signals.py:StructuredDetector',
    },
    {
      id: 'hybrid',
      label: 'Hybrid',
      description: `Tries \`structured\` first; if that returns \`NONE\` (no signal in structured output), falls back to \`regex\`. Best-of-both: pipelines that mostly return structured output but sometimes emit free-form responses get sensible signals either way.`,
      bestFor: [
        'Mixed pipelines — agent usually returns JSON but occasionally talks freely (e.g., asks clarification questions in plain text)',
        'Migration paths — switching from regex-only signals to structured signals across releases without breaking the old path',
      ],
      avoidWhen: [
        'You only ever return one shape. Pick the matching detector and skip the fallback overhead.',
      ],
      gotchas: [
        'Hybrid still depends on the parser. If `structured_output` parser failed and `final_text` doesn\'t contain regex markers either, the result is `NONE`.',
      ],
      codeRef:
        'geny-executor / s09_parse/artifact/default/signals.py:HybridDetector',
    },
  ],
  relatedSections: [
    {
      label: 'Parser (previous slot in this stage)',
      body: '`structured` detector requires `structured_output` parser. `regex` detector works regardless. Pick parser + detector together.',
    },
    {
      label: 'Stage 16 — Loop',
      body: '`state.completion_signal` is what the loop controllers (especially `standard`) key off. `CONTINUE` → loop, `COMPLETE` → terminate success, `ERROR` → terminate failure, etc.',
    },
    {
      label: 'Stage 16 — early_stop_on (stage.config)',
      body: 'You can override the default loop behaviour by listing signals in `early_stop_on` — e.g., `["BLOCKED", "ERROR"]` to terminate on either even if the controller would otherwise continue.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s09_parse/artifact/default/signals.py',
};

const ko: SectionHelpContent = {
  title: '완료 신호 감지기 (Signal detector)',
  summary:
    '\`state.completion_signal\` 이 무엇이 될지 결정 — \`CONTINUE\`, \`COMPLETE\`, \`ERROR\`, \`BLOCKED\`, \`DELEGATE\`, \`NONE\`. 16단계의 루프 컨트롤러가 이를 읽어 계속 루프할지 결정.',
  whatItDoes: `매 턴이 "계속 갈까?" 라는 질문으로 끝남. 신호 감지기가 LLM 이 방금 생산한 것을 inspect 해 답변 — 응답 텍스트, 도구 호출, 응답 자체.

감지기는 두 가지를 씀:

- \`state.completion_signal\` — \`CONTINUE\` (다시 루프), \`COMPLETE\` (완료, 성공), \`ERROR\` (완료, 실패), \`BLOCKED\` (사람 / 외부 액션 필요), \`DELEGATE\` (서브 에이전트로 hand off), \`NONE\` (감지된 신호 없음; controller 결정) 중 하나
- \`state.completion_detail\` — 선택적 사람이 읽을 수 있는 detail 문자열

16단계 (Loop) 가 종료 로직 적용을 위해 이를 읽음. 4단계 (Guard) 와 14단계 (Evaluate) 도 이를 key 로 사용 가능.`,
  options: [
    {
      id: 'regex',
      label: 'Regex',
      description: `\`final_text\` 의 알려진 마커 문자열을 패턴 매칭. 기본 패턴은 인식:

- \`<COMPLETE/>\`, \`[COMPLETE]\`, "Task complete" → \`COMPLETE\`
- \`<ERROR>\`, "I cannot..." → \`ERROR\`
- \`<DELEGATE...>\` → \`DELEGATE\`
- tool_use 블록 존재 → \`CONTINUE\`
- 그 외 → \`NONE\`

가장 싼 감지기 — substring + 작은 regex. 에이전트가 마커를 안정적으로 emit (또는 prompt 됨) 하는 파이프라인에 잘 작동.`,
      bestFor: [
        '명시적 마커를 emit 하도록 신중하게 prompt 된 에이전트의 파이프라인',
        '도구 사용 채팅 에이전트 — 암시적 "tool_use → CONTINUE" 규칙이 대부분의 경우 커버',
        '새 파이프라인의 기본값',
      ],
      avoidWhen: [
        '마커를 안정적으로 emit 하지 않는 에이전트 — `regex` 가 대부분 `NONE` 을 반환하고 16단계 컨트롤러가 결정해야 함',
        '구조화된 신호를 emit 하는 스키마 타입 에이전트 — `structured` 사용',
      ],
      gotchas: [
        'Substring 매칭은 false positive 가능. 에이전트가 "the [COMPLETE] tag would mean we\'re done" 라고 말하면 그것이 메타 논의였음에도 `COMPLETE` 로 파싱.',
      ],
      codeRef:
        'geny-executor / s09_parse/artifact/default/signals.py:RegexDetector',
    },
    {
      id: 'structured',
      label: '구조화 (Structured)',
      description: `\`state.last_api_response.structured_output\` 의 알려진 필드에서 신호 읽음. 구체적으로 구조화 출력의 최상위에서 \`signal\` 과 \`detail\` 키를 찾음.

\`structured_output\` 파서와 자연스럽게 짝 — 에이전트가 \`{"signal": "COMPLETE", "detail": "...", "answer": "..."}\` 를 반환하고 감지기가 signal 필드를 가져옴.`,
      bestFor: [
        '`structured_output` 파서와 짝 지어진 파이프라인 — 스키마가 signal 을 required enum 으로 포함 가능',
        '신호 로직이 타입 체크되어야 하는 워크플로 (스키마가 enum 값 강제)',
      ],
      avoidWhen: [
        '`default` 파서를 쓰고 있을 때 — `structured` 감지기는 읽을 게 없고 항상 `NONE` 반환',
      ],
      gotchas: [
        '`state.last_api_response.structured_output` 채우려면 **`structured_output` 파서 필요**. 이를 default 파서와 짝지으면 silent 항상-`NONE`.',
      ],
      codeRef:
        'geny-executor / s09_parse/artifact/default/signals.py:StructuredDetector',
    },
    {
      id: 'hybrid',
      label: '하이브리드 (Hybrid)',
      description: `\`structured\` 먼저 시도; 그것이 \`NONE\` (구조화 출력에 신호 없음) 반환하면 \`regex\` 로 fallback. 둘의 장점: 대부분 구조화 출력을 반환하지만 가끔 자유 형식 응답을 emit 하는 파이프라인이 양쪽 모두에서 합리적 신호를 받음.`,
      bestFor: [
        '혼합 파이프라인 — 에이전트가 보통 JSON 반환하지만 가끔 자유롭게 말함 (예: 평문으로 명확화 질문)',
        '마이그레이션 경로 — release 간 regex-only 신호에서 구조화 신호로 전환하면서 old path 깨지 않음',
      ],
      avoidWhen: [
        '한 가지 모양만 반환할 때. 매칭하는 감지기를 선택하고 fallback 오버헤드를 skip.',
      ],
      gotchas: [
        'Hybrid 도 여전히 파서에 의존. `structured_output` 파서가 실패하고 `final_text` 도 regex 마커를 포함 안 하면 결과는 `NONE`.',
      ],
      codeRef:
        'geny-executor / s09_parse/artifact/default/signals.py:HybridDetector',
    },
  ],
  relatedSections: [
    {
      label: '파서 (이 단계의 이전 슬롯)',
      body: '`structured` 감지기는 `structured_output` 파서 필요. `regex` 감지기는 무관하게 작동. 파서 + 감지기를 함께 선택.',
    },
    {
      label: '16단계 — Loop',
      body: '`state.completion_signal` 이 루프 컨트롤러 (특히 `standard`) 가 key 로 사용하는 것. `CONTINUE` → 루프, `COMPLETE` → 성공 종료, `ERROR` → 실패 종료, 등.',
    },
    {
      label: '16단계 — early_stop_on (stage.config)',
      body: '`early_stop_on` 에 신호를 나열해 기본 루프 동작 override 가능 — 예: `["BLOCKED", "ERROR"]` 가 컨트롤러가 그 외 계속할 신호여도 둘 중 하나에서 종료.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s09_parse/artifact/default/signals.py',
};

export const stage09SignalHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
