/**
 * Help content for Stage 2 → stateless toggle (stage.config).
 *
 * Source of truth: geny-executor /
 *   src/geny_executor/stages/s02_context/artifact/default/stage.py
 * (ContextStage.should_bypass + get_config_schema)
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Stateless mode',
  summary:
    "A single boolean on `stage.config`. When `true`, the pipeline runner calls `should_bypass()` and **skips Stage 2 entirely** — no message history reading, no memory retrieval, no compaction.",
  whatItDoes: `By default, Stage 2 does three jobs every turn:

- run the **context strategy** to shape \`state.messages\` (e.g., trim to last N turns, inject summary markers)
- run the **retriever** (and optional \`MemoryProvider\`) to pull memory chunks into \`state.memory_refs\` and \`state.metadata.memory_context\`
- run the **compactor** when estimated tokens cross 80% of \`state.context_window_budget\`

Stateless flips one bit: \`should_bypass(state)\` returns \`true\`, the pipeline runner sees that, and Stage 2's \`execute()\` is **never called** for this turn.

**What survives Stateless mode:** whatever Stage 1 just appended to \`state.messages\` (this turn's user message). That's it. Older turns never get re-read into context — at the LLM level the agent looks like it has amnesia between turns.

**What this is for:** one-shot API endpoints, classification or extraction tasks where each call is independent, micro-pipelines run as sub-stages by Stage 12 (agent), or any pipeline where conversation continuity is the host's problem (not the executor's).`,
  configFields: [
    {
      name: 'config.stateless',
      label: 'Stateless',
      type: 'boolean',
      default: 'false',
      description:
        'Bypass context assembly. Stored at `stages[1].config.stateless`. The executor checks this via `update_config()` at restore-time and `should_bypass()` at execute-time.',
    },
  ],
  options: [],
  relatedSections: [
    {
      label: 'Strategy / Compactor / Retriever (this stage)',
      body: 'All three slots are skipped when stateless is on. The choices you make there are stored in the manifest but never executed.',
    },
    {
      label: 'Stage 1 — Input',
      body: 'Stage 1 still runs in stateless mode — the latest user message is appended to `state.messages` as usual. Stateless only affects what happens *after* Stage 1.',
    },
    {
      label: 'Stage 18 — Memory',
      body: 'Stateless does NOT disable Stage 18. If you want zero memory effects, also disable Stage 18 explicitly via its Active toggle.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s02_context/artifact/default/stage.py:ContextStage.should_bypass',
};

const ko: SectionHelpContent = {
  title: 'Stateless 모드',
  summary:
    '`stage.config` 의 단일 boolean. `true` 일 때 파이프라인 runner 가 `should_bypass()` 를 호출하고 **2단계를 통째로 건너뜁니다** — 메시지 히스토리 읽기 없음, 메모리 검색 없음, 압축 없음.',
  whatItDoes: `기본적으로 2단계는 매 턴 세 가지 일을 합니다:

- **컨텍스트 전략**을 실행해 \`state.messages\` 를 모양 잡기 (예: 최근 N 턴으로 자르기, 요약 마커 주입)
- **retriever** (와 선택적 \`MemoryProvider\`) 를 실행해 메모리 청크를 \`state.memory_refs\` 와 \`state.metadata.memory_context\` 로 끌어오기
- 추정 토큰 수가 \`state.context_window_budget\` 의 80% 를 넘으면 **compactor** 실행

Stateless 는 비트 하나를 뒤집습니다: \`should_bypass(state)\` 가 \`true\` 를 반환하고, 파이프라인 runner 가 그것을 보고, 2단계의 \`execute()\` 가 이번 턴에 **호출되지 않습니다**.

**Stateless 모드에서 살아남는 것:** 1단계가 방금 \`state.messages\` 에 추가한 것 (이번 턴의 사용자 메시지). 그게 전부. 이전 턴들은 컨텍스트로 다시 읽히지 않습니다 — LLM 입장에서 에이전트는 턴 사이에 기억상실이 된 것처럼 보입니다.

**무엇에 쓰는가:** 일회성 API 엔드포인트, 각 호출이 독립적인 분류/추출 작업, 12단계 (agent) 가 sub-stage 로 실행하는 마이크로 파이프라인, 또는 대화 연속성이 호스트의 문제 (실행기의 문제가 아닌) 인 모든 파이프라인.`,
  configFields: [
    {
      name: 'config.stateless',
      label: 'Stateless',
      type: 'boolean',
      default: 'false',
      description:
        '컨텍스트 조립 우회. `stages[1].config.stateless` 에 저장. 실행기는 restore 시점에 `update_config()` 로, execute 시점에 `should_bypass()` 로 이 값을 확인합니다.',
    },
  ],
  options: [],
  relatedSections: [
    {
      label: 'Strategy / Compactor / Retriever (이 단계)',
      body: 'stateless 가 켜지면 세 슬롯 모두 건너뜁니다. 거기서 한 선택은 매니페스트에는 저장되지만 실행되지 않습니다.',
    },
    {
      label: '1단계 — Input',
      body: '1단계는 stateless 모드에서도 그대로 실행됩니다 — 최신 사용자 메시지가 평소처럼 `state.messages` 에 추가됩니다. Stateless 는 1단계 *이후* 일어나는 일에만 영향.',
    },
    {
      label: '18단계 — Memory',
      body: 'Stateless 가 18단계를 비활성화하지 않습니다. 메모리 효과를 0 으로 만들고 싶다면 18단계도 Active 토글로 명시적으로 끄세요.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s02_context/artifact/default/stage.py:ContextStage.should_bypass',
};

export const stage02StatelessHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
