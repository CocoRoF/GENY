/**
 * Help content for Stage 9 → Parser slot.
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Response parser',
  summary:
    "Extracts text, tool calls, and thinking blocks from `state.last_api_response` and writes them back to state. Stage 9 is **required** — disabling it stalls the pipeline (downstream stages read what the parser wrote).",
  whatItDoes: `Stage 6 (API) puts the raw response on \`state.last_api_response\`. Stage 9 splits it into structured fields the rest of the pipeline can use:

- \`state.pending_tool_calls\` — list of \`{tool_use_id, tool_name, tool_input}\` for Stage 10 / 11 to act on
- \`state.thinking_history\` — appended thinking blocks (only if Stage 8\'s processor stored them)
- \`state.final_text\` — the assistant's text response, ready for Stage 21 / Stage 17
- \`state.completion_signal\` — set by the **signal detector** (separate slot)

The parser slot decides specifically how to interpret \`response.text\` — as plain text vs as a JSON payload to validate against a schema.

**Stage 9 is required.** \`_STAGE_REQUIRED\` includes s09_parse — disabling it via the Active toggle is allowed for editing manifests but the executor refuses to run with it off.`,
  options: [
    {
      id: 'default',
      label: 'Default',
      description: `Plain extraction. Walks the response's content blocks, pulls text into \`final_text\`, pulls tool_use blocks into \`pending_tool_calls\`, pulls thinking blocks for Stage 8's processor.

The text is treated as opaque — no JSON parsing, no schema validation. If the assistant returned \`{"answer": "yes"}\` as plain text, that string is what \`final_text\` holds.`,
      bestFor: [
        'Chat agents — text in, text out',
        'Tool-using agents — the parser correctly hands tool_use blocks to Stage 10',
        'Default for new pipelines — switch to `structured_output` only when you need JSON validation',
      ],
      avoidWhen: [
        'You\'re asking the model to return strict JSON and want validation before downstream stages see invalid output — use `structured_output`',
      ],
      gotchas: [
        '`final_text` may be empty when the model returns only tool_use blocks (no accompanying text). That\'s normal for tool-call-only turns.',
      ],
      codeRef:
        'geny-executor / s09_parse/artifact/default/parsers.py:DefaultParser',
    },
    {
      id: 'structured_output',
      label: 'Structured output',
      description: `Default's behaviour PLUS: tries to parse \`final_text\` as JSON, optionally validates against a JSON Schema (Draft 7), and stores the parsed object on \`state.last_api_response.structured_output\`.

Parse path:

- direct \`json.loads(text)\`
- if that fails, peel a \`\\\`\\\`\\\`json ... \\\`\\\`\\\`\` code fence and re-try
- if that fails too, error message captured in \`state.last_api_response.structured_output_error\`

When a schema is configured, validation runs after parsing. Schema errors clear \`structured_output\` and surface the path-tagged error message.`,
      bestFor: [
        'API agents whose outputs must be machine-readable JSON (one specific shape)',
        'Pipelines where downstream code (host post-processing, Stage 17 emitters) expects \`state.last_api_response.structured_output\` to be a dict',
        'Eval / classification pipelines — schema validates the model returned the expected enum',
      ],
      avoidWhen: [
        'The model occasionally returns prose explanation alongside JSON — strict schema validation will reject those turns. Either prompt the model harder for pure JSON or accept a more lenient setup.',
      ],
      config: [
        {
          name: 'schema',
          label: 'JSON Schema',
          type: 'object',
          description:
            'Optional Draft-7 schema. Empty / null = parse JSON without validation (still useful — captures parse errors, gives you the dict). Validated at `__init__` AND `configure()` time so malformed schemas surface immediately. Stored at `strategy_configs.parser.schema`.',
        },
      ],
      gotchas: [
        'The schema is validated as a *schema* (`Draft7Validator.check_schema`) when set. If your schema is itself malformed, `configure()` raises immediately — no silent failure.',
        'Schema validation rejects invalid JSON shapes by clearing `structured_output` and setting `structured_output_error`. The text on `final_text` is unchanged — downstream stages may still surface the unvalidated text.',
        'Only `final_text` is parsed, not tool_use input dicts. Tool inputs are already structured (the model returned them as JSON via the API\'s tool_use mechanism).',
      ],
      codeRef:
        'geny-executor / s09_parse/artifact/default/parsers.py:StructuredOutputParser',
    },
  ],
  relatedSections: [
    {
      label: 'Signal detector (next slot in this stage)',
      body: 'The detector decides what `state.completion_signal` becomes (CONTINUE / COMPLETE / ERROR / DELEGATE / etc.). Independent of the parser — same response, different concern.',
    },
    {
      label: 'Stage 1 — Schema validator',
      body: 'Stage 1\'s `schema` validator validates **input**; Stage 9\'s `structured_output` validates **output**. Same JSON-Schema-Draft-7 spirit, opposite direction.',
    },
    {
      label: 'Stage 10 — Tool',
      body: 'Stage 10 reads `state.pending_tool_calls` to actually execute the tool calls. The parser is what populates that list — without Stage 9 running, Stage 10 has nothing to do.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s09_parse/artifact/default/parsers.py',
};

const ko: SectionHelpContent = {
  title: '응답 파서 (Parser)',
  summary:
    '\`state.last_api_response\` 에서 텍스트, tool calls, thinking 블록을 추출해 state 에 다시 씀. 9단계는 **필수** — 비활성화하면 파이프라인이 정지 (하류 단계가 파서가 쓴 것을 읽음).',
  whatItDoes: `6단계 (API) 가 raw 응답을 \`state.last_api_response\` 에 둠. 9단계가 그것을 파이프라인 나머지가 사용할 수 있는 구조화된 필드로 split:

- \`state.pending_tool_calls\` — 10단계 / 11단계가 작용할 \`{tool_use_id, tool_name, tool_input}\` 리스트
- \`state.thinking_history\` — 추가된 thinking 블록 (8단계의 processor 가 저장한 경우만)
- \`state.final_text\` — 어시스턴트의 텍스트 응답, 21단계 / 17단계 준비 완료
- \`state.completion_signal\` — **signal detector** (별도 슬롯) 가 설정

파서 슬롯은 \`response.text\` 를 어떻게 해석할지를 구체적으로 결정 — 평문 vs 스키마 검증할 JSON 페이로드.

**9단계는 필수.** \`_STAGE_REQUIRED\` 가 s09_parse 포함 — Active 토글로 비활성화는 매니페스트 편집에는 허용되지만 실행기는 그것이 꺼진 상태로 실행 거부.`,
  options: [
    {
      id: 'default',
      label: '기본 (Default)',
      description: `평문 추출. 응답의 content 블록을 walk, 텍스트를 \`final_text\` 로 추출, tool_use 블록을 \`pending_tool_calls\` 로 추출, thinking 블록을 8단계의 processor 용으로 추출.

텍스트는 opaque 로 취급 — JSON 파싱 없음, 스키마 검증 없음. 어시스턴트가 \`{"answer": "yes"}\` 를 평문으로 반환했다면 그 문자열이 \`final_text\` 가 보유하는 것.`,
      bestFor: [
        '채팅 에이전트 — 텍스트 in, 텍스트 out',
        '도구 사용 에이전트 — 파서가 tool_use 블록을 10단계로 올바르게 전달',
        '새 파이프라인의 기본값 — JSON 검증이 필요할 때만 `structured_output` 으로 전환',
      ],
      avoidWhen: [
        '모델에 엄격한 JSON 반환을 요청하고 하류 단계가 invalid 출력을 보기 전에 검증을 원할 때 — `structured_output` 사용',
      ],
      gotchas: [
        '모델이 tool_use 블록만 반환할 때 (텍스트 동반 없이) `final_text` 가 비어있을 수 있음. 도구 호출만의 턴에 정상.',
      ],
      codeRef:
        'geny-executor / s09_parse/artifact/default/parsers.py:DefaultParser',
    },
    {
      id: 'structured_output',
      label: '구조화 출력 (Structured output)',
      description: `Default 의 동작 + \`final_text\` 를 JSON 으로 파싱 시도, 선택적으로 JSON Schema (Draft 7) 에 대해 검증, 파싱된 객체를 \`state.last_api_response.structured_output\` 에 저장.

파싱 경로:

- 직접 \`json.loads(text)\`
- 실패하면 \`\\\`\\\`\\\`json ... \\\`\\\`\\\`\` 코드 펜스를 벗기고 재시도
- 그것도 실패하면 에러 메시지가 \`state.last_api_response.structured_output_error\` 에 캡처

스키마가 설정되면 검증이 파싱 후 실행. 스키마 에러는 \`structured_output\` 을 비우고 path-tagged 에러 메시지를 surface.`,
      bestFor: [
        '출력이 machine-readable JSON 이어야 하는 (특정 모양) API 에이전트',
        '하류 코드 (호스트 후처리, 17단계 emitter) 가 `state.last_api_response.structured_output` 을 dict 로 기대하는 파이프라인',
        '평가 / 분류 파이프라인 — 스키마가 모델이 예상 enum 을 반환했음을 검증',
      ],
      avoidWhen: [
        '모델이 가끔 JSON 과 함께 산문 설명을 반환할 때 — 엄격한 스키마 검증이 그런 턴을 거부. 모델에 순수 JSON 을 더 강하게 prompt 하거나 더 lenient 한 설정 수용.',
      ],
      config: [
        {
          name: 'schema',
          label: 'JSON Schema',
          type: 'object',
          description:
            '선택적 Draft-7 스키마. 비어있음 / null = 검증 없이 JSON 파싱 (여전히 유용 — 파싱 에러 캡처, dict 제공). `__init__` AND `configure()` 시점에 검증되어 잘못된 스키마는 즉시 surface. `strategy_configs.parser.schema` 에 저장.',
        },
      ],
      gotchas: [
        '스키마 자체가 *스키마* 로 검증됨 (`Draft7Validator.check_schema`) 설정 시. 스키마 자체가 잘못되면 `configure()` 가 즉시 raise — silent 실패 없음.',
        '스키마 검증은 invalid JSON 모양을 `structured_output` 비우기 + `structured_output_error` 설정으로 거부. `final_text` 의 텍스트는 변경 없음 — 하류 단계가 검증 안 된 텍스트를 여전히 surface 할 수 있음.',
        '`final_text` 만 파싱, tool_use input dict 는 아님. 도구 input 은 이미 구조화 (모델이 API 의 tool_use 메커니즘으로 JSON 으로 반환).',
      ],
      codeRef:
        'geny-executor / s09_parse/artifact/default/parsers.py:StructuredOutputParser',
    },
  ],
  relatedSections: [
    {
      label: '신호 감지기 (이 단계의 다음 슬롯)',
      body: 'Detector 가 `state.completion_signal` 이 무엇이 될지 결정 (CONTINUE / COMPLETE / ERROR / DELEGATE / 등). 파서와 독립 — 같은 응답, 다른 관심사.',
    },
    {
      label: '1단계 — Schema validator',
      body: '1단계의 `schema` validator 는 **입력** 검증; 9단계의 `structured_output` 은 **출력** 검증. 같은 JSON-Schema-Draft-7 정신, 반대 방향.',
    },
    {
      label: '10단계 — Tool',
      body: '10단계가 `state.pending_tool_calls` 를 읽어 실제로 도구 호출을 실행. 파서가 그 리스트를 채우는 것 — 9단계 실행 없이 10단계는 할 일이 없음.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s09_parse/artifact/default/parsers.py',
};

export const stage09ParserHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
