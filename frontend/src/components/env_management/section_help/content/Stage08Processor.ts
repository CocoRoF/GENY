/**
 * Help content for Stage 8 → Thinking processor slot.
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Thinking processor',
  summary:
    "What to do with thinking content blocks the LLM emitted this turn. The processor sees only `ThinkingBlock` items, not the rest of the response — its decisions are about *what to keep / store / drop*, not the final text.",
  whatItDoes: `Stage 9 (Parse) splits the API response into text + tool_calls + thinking. Stage 8 catches the thinking blocks before they go anywhere else and decides their fate.

Two outputs the processor can affect:

- the **return value** — the (possibly filtered) list of blocks the rest of the pipeline sees
- **\`state.thinking_history\`** — a list mutated in place. Stage 9 / 21 / external observers read this for things like "show the user's reasoning trace" or "audit what the model thought".

Most pipelines don't need to do anything fancy here — \`passthrough\` is the right default. The custom options matter only when:

- the host wants a separate UI surface for thinking (\`extract_and_store\`)
- the model emits thinking content the host doesn't want stored at all (compliance / privacy → \`filter\`)`,
  options: [
    {
      id: 'passthrough',
      label: 'Passthrough',
      description: `No-op. Returns the thinking blocks unchanged. Does not touch \`state.thinking_history\`.

Default. The right pick when downstream consumers handle thinking themselves (Stage 9 already extracts text, Stage 21 may surface thinking via \`MultiFormatFormatter\`'s include_thinking).`,
      bestFor: [
        'Default pipelines — Stage 9 / 21 already do what most agents need',
        'Pipelines where thinking is purely internal and doesn\'t need to be persisted as a separate stream',
      ],
      avoidWhen: [
        'You want thinking searchable / queryable across turns — `extract_and_store` builds that history',
      ],
      codeRef:
        'geny-executor / s08_think/artifact/default/processors.py:PassthroughProcessor',
    },
    {
      id: 'extract_and_store',
      label: 'Extract & store',
      description: `Appends each thinking block to \`state.thinking_history\` as \`{iteration, text, tokens}\`. The list grows by one entry per thinking block per turn — useful when the host wants to render a separate "reasoning trail" or analyse it after the session.`,
      bestFor: [
        'Reasoning-trail UI — host renders `state.thinking_history` as a separate panel',
        'Compliance / audit logs — keep a verbatim record of model reasoning per session',
        'Research / eval pipelines — analyse thinking content vs final text correlation',
      ],
      avoidWhen: [
        'Long sessions — `state.thinking_history` grows unbounded and rides in `state.metadata` (snapshotted)',
        'Pipelines that don\'t actually consume thinking history — pure overhead',
      ],
      gotchas: [
        'No deduplication. If the same thinking content appears twice (model retries, identical iterations), it\'s stored twice.',
      ],
      codeRef:
        'geny-executor / s08_think/artifact/default/processors.py:ExtractAndStoreProcessor',
    },
    {
      id: 'filter',
      label: 'Filter',
      description: `Drops thinking blocks that contain any string in \`exclude_patterns\` (case-sensitive substring match). Surviving blocks pass through unchanged.

Useful when the model emits internal reasoning the host shouldn't store or show — e.g., reasoning that mentions PII, prompt-engineering hints, or competitor names.`,
      bestFor: [
        'Compliance pipelines that must scrub model reasoning (e.g., PII strings)',
        'Public-facing reasoning views where you must hide certain prompts / brand mentions',
        'Multi-tenant pipelines where one tenant\'s data must not appear in another tenant\'s reasoning trail',
      ],
      avoidWhen: [
        'Your filter list grows large — substring scanning every block on every turn adds up',
        'You need semantic filtering (regex, NLP) — this is plain substring',
      ],
      config: [
        {
          name: 'exclude_patterns',
          label: 'Exclude patterns',
          type: 'list[string]',
          default: '[]',
          description:
            'Substrings to match against each block\'s text. Any match drops the block. Case-sensitive (unlike Stage 1\'s strict validator). Stored at `strategy_configs.processor.exclude_patterns`. Empty = no-op (equivalent to passthrough).',
        },
      ],
      gotchas: [
        '**Case-sensitive** — `"SECRET"` does not match `"secret"`. (Different from Stage 1\'s strict validator which is case-insensitive — be careful when copying patterns between stages.)',
        'Substring match — same trap as Stage 1\'s strict: `"ass"` matches `"class"`.',
        'Filter runs before `extract_and_store` would (they\'re on the same slot — pick one). If you want both store-then-filter or filter-then-store, you\'ll need a custom processor.',
      ],
      codeRef:
        'geny-executor / s08_think/artifact/default/processors.py:ThinkingFilterProcessor',
    },
  ],
  relatedSections: [
    {
      label: 'Budget planner (next slot in this stage)',
      body: 'The budget planner runs *before* the API call and decides how many thinking tokens this turn gets. Processor runs *after* the call and decides what to do with the thinking that came back.',
    },
    {
      label: 'Stage 9 — Parse',
      body: 'Stage 9 is what splits the API response into thinking / text / tool_calls. By the time Stage 8\'s processor runs, the split has already happened.',
    },
    {
      label: 'Stage 21 — Yield (multi_format)',
      body: '`MultiFormatFormatter` has `include_thinking=True` to fold the most recent thinking turn into markdown output. That reads `state.thinking_history` — only populated if you used `extract_and_store` (or a similar custom processor).',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s08_think/artifact/default/processors.py',
};

const ko: SectionHelpContent = {
  title: 'Thinking 프로세서',
  summary:
    'LLM 이 이번 턴에 emit 한 thinking content 블록으로 무엇을 할지. 프로세서는 응답 나머지가 아닌 \`ThinkingBlock\` 항목만 봄 — 결정은 *무엇을 유지/저장/제거할지* 에 관한 것이지 최종 텍스트가 아님.',
  whatItDoes: `9단계 (Parse) 가 API 응답을 텍스트 + tool_calls + thinking 으로 split. 8단계가 thinking 블록이 다른 곳으로 가기 전에 잡고 운명 결정.

프로세서가 영향 줄 수 있는 두 출력:

- **반환값** — (가능하게 필터링된) 블록 리스트, 파이프라인 나머지가 보는 것
- **\`state.thinking_history\`** — in-place 로 변형되는 리스트. 9단계 / 21단계 / 외부 관찰자가 "사용자의 추론 trace 표시" 나 "모델이 무엇을 생각했는지 audit" 같은 것을 위해 읽음.

대부분의 파이프라인은 여기서 fancy 한 것을 할 필요 없음 — \`passthrough\` 가 옳은 기본값. 커스텀 옵션은 다음 경우만 중요:

- 호스트가 thinking 을 위한 별도 UI surface 를 원함 (\`extract_and_store\`)
- 모델이 호스트가 저장하고 싶지 않은 thinking content 를 emit (컴플라이언스 / 프라이버시 → \`filter\`)`,
  options: [
    {
      id: 'passthrough',
      label: 'Passthrough',
      description: `No-op. thinking 블록을 변경 없이 반환. \`state.thinking_history\` 건드리지 않음.

기본값. 하류 소비자가 thinking 을 자체 처리할 때 옳은 선택 (9단계가 이미 텍스트 추출, 21단계가 \`MultiFormatFormatter\` 의 include_thinking 으로 thinking 을 surface 가능).`,
      bestFor: [
        '기본 파이프라인 — 9단계 / 21단계가 이미 대부분의 에이전트가 필요한 것을 함',
        'thinking 이 순전히 내부적이고 별도 stream 으로 persistent 될 필요 없는 파이프라인',
      ],
      avoidWhen: [
        '턴 간 thinking 을 검색/쿼리 가능하게 원할 때 — `extract_and_store` 가 그 히스토리 빌드',
      ],
      codeRef:
        'geny-executor / s08_think/artifact/default/processors.py:PassthroughProcessor',
    },
    {
      id: 'extract_and_store',
      label: '추출 + 저장 (Extract & store)',
      description: `각 thinking 블록을 \`{iteration, text, tokens}\` 으로 \`state.thinking_history\` 에 추가. 리스트가 턴별 thinking 블록당 한 항목씩 증가 — 호스트가 별도 "reasoning trail" 을 렌더하거나 세션 후 분석할 때 유용.`,
      bestFor: [
        'Reasoning-trail UI — 호스트가 `state.thinking_history` 를 별도 패널로 렌더',
        '컴플라이언스 / 감사 로그 — 세션별 모델 reasoning 의 verbatim 기록 유지',
        '연구 / 평가 파이프라인 — thinking content vs 최종 텍스트 상관관계 분석',
      ],
      avoidWhen: [
        '장기 세션 — `state.thinking_history` 가 무제한 증가하고 `state.metadata` (스냅샷됨) 에 탑승',
        'thinking 히스토리를 실제로 소비하지 않는 파이프라인 — 순수 오버헤드',
      ],
      gotchas: [
        '중복 제거 없음. 같은 thinking content 가 두 번 나타나면 (모델 재시도, 동일 반복), 두 번 저장됨.',
      ],
      codeRef:
        'geny-executor / s08_think/artifact/default/processors.py:ExtractAndStoreProcessor',
    },
    {
      id: 'filter',
      label: '필터 (Filter)',
      description: `\`exclude_patterns\` 의 어떤 문자열이라도 포함하는 thinking 블록을 drop (대소문자 구분 substring 매칭). 살아남은 블록은 변경 없이 통과.

호스트가 저장하거나 보여주면 안 되는 내부 reasoning 을 모델이 emit 할 때 유용 — 예: PII 를 언급하는 reasoning, 프롬프트 엔지니어링 힌트, 경쟁사 이름.`,
      bestFor: [
        '모델 reasoning 을 scrub 해야 하는 컴플라이언스 파이프라인 (예: PII 문자열)',
        '특정 prompt / 브랜드 언급을 숨겨야 하는 공개 reasoning 뷰',
        '한 tenant 의 데이터가 다른 tenant 의 reasoning trail 에 나타나면 안 되는 멀티 테넌트 파이프라인',
      ],
      avoidWhen: [
        '필터 리스트가 커질 때 — 매 턴 모든 블록을 substring 스캔하면 누적됨',
        '의미 기반 필터링 (regex, NLP) 이 필요할 때 — 이는 단순 substring',
      ],
      config: [
        {
          name: 'exclude_patterns',
          label: '제외 패턴',
          type: 'list[string]',
          default: '[]',
          description:
            '각 블록의 텍스트와 매칭할 substring. 매칭하면 블록 drop. 대소문자 구분 (1단계의 strict validator 와 다름). `strategy_configs.processor.exclude_patterns` 에 저장. 비어있음 = no-op (passthrough 와 동등).',
        },
      ],
      gotchas: [
        '**대소문자 구분** — `"SECRET"` 은 `"secret"` 과 매칭 안 됨. (1단계의 strict validator 가 대소문자 무시인 것과 다름 — 단계 간 패턴 복사 시 주의.)',
        'Substring 매칭 — 1단계 strict 와 동일한 trap: `"ass"` 가 `"class"` 매칭.',
        '필터가 `extract_and_store` 가 했을 동작 *이전*에 실행 (둘은 같은 슬롯 — 하나만 선택). store-then-filter 또는 filter-then-store 둘 다 원하면 커스텀 processor 필요.',
      ],
      codeRef:
        'geny-executor / s08_think/artifact/default/processors.py:ThinkingFilterProcessor',
    },
  ],
  relatedSections: [
    {
      label: 'Budget planner (이 단계의 다음 슬롯)',
      body: 'Budget planner 는 API 호출 *전*에 실행되어 이번 턴이 받을 thinking 토큰 수 결정. Processor 는 호출 *후* 실행되어 돌아온 thinking 으로 무엇을 할지 결정.',
    },
    {
      label: '9단계 — Parse',
      body: '9단계가 API 응답을 thinking / 텍스트 / tool_calls 로 split. 8단계의 processor 가 실행될 때 split 은 이미 일어남.',
    },
    {
      label: '21단계 — Yield (multi_format)',
      body: '`MultiFormatFormatter` 에 `include_thinking=True` 가 있어 가장 최근 thinking 턴을 markdown 출력으로 fold. 그것이 `state.thinking_history` 를 읽음 — `extract_and_store` (또는 유사한 커스텀 프로세서) 를 사용한 경우만 채워짐.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s08_think/artifact/default/processors.py',
};

export const stage08ProcessorHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
