/**
 * Help content for Stage 21 → Formatter slot.
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Result formatter',
  summary:
    "The pipeline's exit point. Reads `state.final_text` (and other state fields) and produces `state.final_output` — the shape the host eventually receives. Stage 21 is **required**; disabling it stalls the pipeline.",
  whatItDoes: `Stage 21 runs in the post-loop tail, after Stage 20 (Persist). It's the last thing the executor does before handing control back to the host. The formatter chooses what shape \`state.final_output\` takes:

- a plain string (default — same as \`final_text\`)
- a structured dict (text + cost + tokens + signal)
- a streaming summary event (same dict, emitted as event for stream-consumers)
- multiple shapes simultaneously (text + structured + markdown)

**The host receives \`state.final_output\`** at the end of the pipeline run. Picking the right formatter is about matching the consumer's expectation.

**Stage 21 is required** — \`_STAGE_REQUIRED\` includes s21_yield. Disabling via the Active toggle is allowed in the manifest editor for editing convenience, but the executor refuses to run with it off.`,
  options: [
    {
      id: 'default',
      label: 'Default',
      description: `Pass-through. \`state.final_output = state.final_text\`. The host gets a plain string — the assistant's text response.

The right pick for chat agents and any pipeline where the host code expects a string.`,
      bestFor: [
        'Chat agents — string out, simple',
        'Pipelines integrating with text-only consumers (Slack, Discord, terminal output)',
        'Default for new pipelines',
      ],
      avoidWhen: [
        'You want cost / token / completion-signal info alongside text — use `structured`',
      ],
      codeRef:
        'geny-executor / s21_yield/artifact/default/formatters.py:DefaultFormatter',
    },
    {
      id: 'structured',
      label: 'Structured',
      description: `\`state.final_output\` becomes a dict:

\`\`\`
{
  text: state.final_text,
  model: state.model,
  iterations: state.iteration,
  cost: state.total_cost_usd,
  token_usage: {...},
  completion_signal: state.completion_signal,
  completion_detail: state.completion_detail,
}
\`\`\`

Useful when the host needs metadata alongside the response — billing, analytics, debugging. Consumers must deserialise the dict to access individual fields.`,
      bestFor: [
        'API endpoints returning JSON — host can pass `final_output` straight through to the HTTP response',
        'Analytics-heavy pipelines that need cost / token info per request',
        'Pipelines where downstream code branches on `completion_signal`',
      ],
      avoidWhen: [
        'Host expects a plain string — they\'d need to extract `.text` from the dict, which adds a coupling point',
      ],
      codeRef:
        'geny-executor / s21_yield/artifact/default/formatters.py:StructuredFormatter',
    },
    {
      id: 'streaming',
      label: 'Streaming',
      description: `Same shape as \`structured\` but emitted as a \`yield.summary\` event instead of (only) writing \`state.final_output\`. Stream consumers (websocket / SSE) listen for the event and receive the summary as it's produced.

\`state.final_output\` is also set so non-streaming consumers still work. The streaming aspect is purely additive.`,
      bestFor: [
        'Pipelines fronted by a streaming protocol (SSE, WebSocket)',
        'UIs that surface progress / completion as events',
        'Long-running agents where the host wants to see the final summary as soon as the pipeline yields',
      ],
      avoidWhen: [
        'Synchronous request/response APIs — the event-streaming machinery is unused, picks default',
      ],
      gotchas: [
        'Streaming requires the host\'s event consumer to be wired. Without it, the event fires into the void — but `state.final_output` is still set, so the basic exit still works.',
      ],
      codeRef:
        'geny-executor / s21_yield/artifact/default/formatters.py:StreamingFormatter',
    },
    {
      id: 'multi_format',
      label: 'Multi-format',
      description: `\`state.final_output\` becomes a dict keyed by format name. Consumers select the format they want:

\`\`\`
{
  "text": "...",       // plain text
  "structured": {...}, // structured dict (same as StructuredFormatter)
  "markdown": "..."    // human-readable markdown with optional thinking
}
\`\`\`

The set of formats produced is configurable — pick a subset if you don't need all three. Saves on serialisation cost when the host never reads (say) the markdown view.

\`include_thinking=True\` folds the most recent thinking block into the markdown output (read from \`state.thinking_history\`, which Stage 8's \`extract_and_store\` processor populates).`,
      bestFor: [
        'Pipelines serving multiple consumers — one format for the API response, another for human review',
        'Agents whose output is displayed in different contexts (web UI + Slack export + audit trail)',
        'Debug pipelines that want both structured metadata AND a human-readable summary',
      ],
      avoidWhen: [
        'Single-consumer pipelines — extra serialisation cost for unused formats',
      ],
      config: [
        {
          name: 'formats',
          label: 'Formats',
          type: 'list[string]',
          default: '["text", "structured", "markdown"]',
          description:
            'Subset of `{text, structured, markdown}` to emit. Order is preserved in the output dict. Stored at `strategy_configs.formatter.formats`.',
        },
        {
          name: 'include_thinking',
          label: 'Include thinking in markdown',
          type: 'boolean',
          default: 'false',
          description:
            'When true, the markdown output includes the most recent thinking block. Requires Stage 8\'s `extract_and_store` (or similar) processor to have populated `state.thinking_history` — without it, this is a no-op.',
        },
      ],
      gotchas: [
        '`include_thinking` is silently a no-op if Stage 8 doesn\'t store thinking history. The markdown still renders — just without thinking content.',
        'At least one format must be selected. The validator rejects an empty `formats` list at construction time.',
      ],
      codeRef:
        'geny-executor / s21_yield/artifact/default/multi_format.py:MultiFormatFormatter',
    },
  ],
  relatedSections: [
    {
      label: 'Stage 17 — Emit',
      body: 'Stage 17 *delivers* the response to consumers each turn. Stage 21 produces the final shape at session end. They run at different points: Stage 17 per-turn (in the loop), Stage 21 once at the end.',
    },
    {
      label: 'Stage 8 — Thinking processor',
      body: '`multi_format` with `include_thinking=True` reads `state.thinking_history`, which Stage 8\'s `extract_and_store` processor fills. Pair them or accept that thinking won\'t appear in markdown.',
    },
    {
      label: 'Stage 7 — Token / cost',
      body: '`structured` and `multi_format` (structured) include cost / token info. Without Stage 7 running, those fields are 0 — accurate but uninformative.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s21_yield/artifact/default/formatters.py',
};

const ko: SectionHelpContent = {
  title: '결과 포맷터 (Formatter)',
  summary:
    '파이프라인의 exit 지점. \`state.final_text\` (및 다른 state 필드) 읽고 \`state.final_output\` 생산 — 호스트가 결국 받는 모양. 21단계는 **필수**; 비활성화는 파이프라인 정지.',
  whatItDoes: `21단계는 20단계 (Persist) 후 post-loop tail 에서 실행. 호스트에 제어 돌려주기 전 실행기가 하는 마지막 것. 포맷터가 \`state.final_output\` 이 어떤 모양이 될지 선택:

- 평문 문자열 (기본 — \`final_text\` 와 동일)
- 구조화 dict (텍스트 + 비용 + 토큰 + 신호)
- 스트리밍 요약 이벤트 (같은 dict, 스트림 소비자용 이벤트로 emit)
- 여러 모양 동시 (텍스트 + 구조화 + 마크다운)

**호스트가 파이프라인 실행 끝에 \`state.final_output\` 받음.** 옳은 포맷터 선택은 소비자의 기대 매칭에 관한 것.

**21단계는 필수** — \`_STAGE_REQUIRED\` 가 s21_yield 포함. Active 토글로 비활성화는 편집 편의를 위해 매니페스트 에디터에서 허용되지만, 실행기는 그것이 꺼진 상태로 실행 거부.`,
  options: [
    {
      id: 'default',
      label: '기본 (Default)',
      description: `Pass-through. \`state.final_output = state.final_text\`. 호스트가 평문 문자열 받음 — 어시스턴트의 텍스트 응답.

채팅 에이전트와 호스트 코드가 문자열 기대하는 모든 파이프라인에 옳은 선택.`,
      bestFor: [
        '채팅 에이전트 — 문자열 out, 단순',
        '텍스트 전용 소비자 (Slack, Discord, 터미널 출력) 와 통합하는 파이프라인',
        '새 파이프라인의 기본값',
      ],
      avoidWhen: [
        '텍스트와 함께 비용 / 토큰 / 완료 신호 정보 원할 때 — `structured` 사용',
      ],
      codeRef:
        'geny-executor / s21_yield/artifact/default/formatters.py:DefaultFormatter',
    },
    {
      id: 'structured',
      label: '구조화 (Structured)',
      description: `\`state.final_output\` 이 dict 가 됨:

\`\`\`
{
  text: state.final_text,
  model: state.model,
  iterations: state.iteration,
  cost: state.total_cost_usd,
  token_usage: {...},
  completion_signal: state.completion_signal,
  completion_detail: state.completion_detail,
}
\`\`\`

호스트가 응답과 함께 메타데이터 필요할 때 유용 — 청구, 분석, 디버깅. 소비자가 개별 필드 접근 위해 dict deserialise 해야 함.`,
      bestFor: [
        'JSON 반환하는 API 엔드포인트 — 호스트가 `final_output` 을 HTTP 응답에 그대로 통과 가능',
        '요청별 비용 / 토큰 정보 필요한 분석 무거운 파이프라인',
        '하류 코드가 `completion_signal` 에 분기하는 파이프라인',
      ],
      avoidWhen: [
        '호스트가 평문 문자열 기대할 때 — dict 에서 `.text` 추출 필요, 결합점 추가',
      ],
      codeRef:
        'geny-executor / s21_yield/artifact/default/formatters.py:StructuredFormatter',
    },
    {
      id: 'streaming',
      label: '스트리밍 (Streaming)',
      description: `\`structured\` 와 같은 모양이지만 \`state.final_output\` 쓰기 (만) 대신 \`yield.summary\` 이벤트로 emit. 스트림 소비자 (websocket / SSE) 가 이벤트 listen 해서 생산되면서 요약 받음.

\`state.final_output\` 도 설정되어 비-스트리밍 소비자도 여전히 작동. 스트리밍 측면은 순전히 additive.`,
      bestFor: [
        '스트리밍 프로토콜 (SSE, WebSocket) 으로 fronted 된 파이프라인',
        '진행 / 완료를 이벤트로 surface 하는 UI',
        '파이프라인이 yield 하자마자 호스트가 최종 요약 보길 원하는 장기 에이전트',
      ],
      avoidWhen: [
        '동기 요청/응답 API — 이벤트 스트리밍 machinery 미사용, default 선택',
      ],
      gotchas: [
        '스트리밍은 호스트의 이벤트 소비자가 wire 되어야 함. 없으면 이벤트가 void 로 발화 — 하지만 `state.final_output` 은 여전히 설정되어 기본 exit 는 여전히 작동.',
      ],
      codeRef:
        'geny-executor / s21_yield/artifact/default/formatters.py:StreamingFormatter',
    },
    {
      id: 'multi_format',
      label: '멀티 포맷 (Multi-format)',
      description: `\`state.final_output\` 이 포맷 이름으로 키된 dict 가 됨. 소비자가 원하는 포맷 선택:

\`\`\`
{
  "text": "...",       // 평문
  "structured": {...}, // 구조화 dict (StructuredFormatter 와 동일)
  "markdown": "..."    // 선택적 thinking 이 있는 사람이 읽을 수 있는 마크다운
}
\`\`\`

생산되는 포맷 집합 구성 가능 — 셋 다 필요 없으면 부분집합 선택. 호스트가 (예: markdown 뷰를) 절대 안 읽으면 직렬화 비용 절약.

\`include_thinking=True\` 가 가장 최근 thinking 블록을 마크다운 출력으로 fold (\`state.thinking_history\` 에서 읽음, 8단계의 \`extract_and_store\` 프로세서가 채움).`,
      bestFor: [
        '여러 소비자 서비스하는 파이프라인 — API 응답용 한 포맷, 사람 review 용 다른 포맷',
        '다른 컨텍스트에서 출력 표시되는 에이전트 (웹 UI + Slack export + 감사 trail)',
        '구조화 메타데이터 AND 사람이 읽을 수 있는 요약 둘 다 원하는 디버그 파이프라인',
      ],
      avoidWhen: [
        '단일 소비자 파이프라인 — 미사용 포맷의 추가 직렬화 비용',
      ],
      config: [
        {
          name: 'formats',
          label: '포맷',
          type: 'list[string]',
          default: '["text", "structured", "markdown"]',
          description:
            'emit 할 `{text, structured, markdown}` 의 부분집합. 출력 dict 에서 순서 보존. `strategy_configs.formatter.formats` 에 저장.',
        },
        {
          name: 'include_thinking',
          label: 'markdown 에 thinking 포함',
          type: 'boolean',
          default: 'false',
          description:
            'true 일 때 마크다운 출력이 가장 최근 thinking 블록 포함. 8단계의 `extract_and_store` (또는 유사한) 프로세서가 `state.thinking_history` 채웠어야 함 — 그것 없이 이는 no-op.',
        },
      ],
      gotchas: [
        '8단계가 thinking 히스토리 저장 안 하면 `include_thinking` 이 silent 하게 no-op. 마크다운은 여전히 렌더 — 단지 thinking 내용 없이.',
        '최소 한 포맷은 선택되어야 함. validator 가 생성 시점에 빈 `formats` 리스트 거부.',
      ],
      codeRef:
        'geny-executor / s21_yield/artifact/default/multi_format.py:MultiFormatFormatter',
    },
  ],
  relatedSections: [
    {
      label: '17단계 — Emit',
      body: '17단계가 매 턴 응답을 소비자에게 *전달*. 21단계가 세션 끝에서 최종 모양 생산. 다른 시점 실행: 17단계는 턴별 (루프 내), 21단계는 끝에서 한 번.',
    },
    {
      label: '8단계 — Thinking 프로세서',
      body: '`include_thinking=True` 의 `multi_format` 이 `state.thinking_history` 읽음, 8단계의 `extract_and_store` 프로세서가 채움. 짝짓거나 thinking 이 마크다운에 안 나타날 것 수용.',
    },
    {
      label: '7단계 — Token / 비용',
      body: '`structured` 와 `multi_format` (structured) 이 비용 / 토큰 정보 포함. 7단계 실행 없이 그 필드들이 0 — 정확하지만 uninformative.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s21_yield/artifact/default/formatters.py',
};

export const stage21FormatterHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
