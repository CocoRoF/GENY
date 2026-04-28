/**
 * Help content for Stage 18 → Memory model override section.
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Memory model',
  summary:
    "Per-stage `model_override` for Stage 18. Used by `reflective` and `structured_reflective` strategies for their LLM-driven insight extraction. Plain `append_only` and `no_memory` strategies don't call an LLM and ignore this section.",
  whatItDoes: `Stage 18\'s reflective strategies make an LLM call per turn to extract insights. Without an override here, that call uses the pipeline\'s default model — usually wasteful, since insight extraction is a much simpler task than the main agent\'s reasoning.

The override mechanism is the same as Stage 6\'s — \`Stage.resolve_model_config\` layers \`entry.model_override\` over the pipeline default. The right pattern for memory:

- main agent on Claude Opus / Sonnet for reasoning quality
- memory on Claude Haiku / cheaper for insight extraction (10× cheaper, quality penalty negligible for this task)

The toggle is hidden / inert when the strategy doesn't use it. \`append_only\` / \`no_memory\` selected → the model section is purely informational, since no LLM call happens.`,
  configFields: [
    {
      name: 'model_override.model',
      label: 'Model',
      type: 'string',
      description:
        'Override model just for Stage 18\'s LLM call. Pick a cheap model — insight extraction doesn\'t need the same reasoning capability as the main agent.',
    },
    {
      name: 'model_override.system_prompt',
      label: 'System prompt',
      type: 'string',
      description:
        'Per-stage system prompt. The reflective strategies have their own internal prompt for insight extraction; this override REPLACES that. Use only when you need to customise the extraction style — usually leave default.',
    },
    {
      name: 'model_override.max_tokens',
      label: 'Max tokens',
      type: 'integer',
      description:
        'Cap on the insight extraction output. Insights are usually short — 500-1000 tokens is plenty.',
    },
    {
      name: 'model_override.temperature',
      label: 'Temperature',
      type: 'number',
      description:
        'For insight extraction, low temperature (0–0.3) is usually right — you want consistent, deterministic extraction, not creativity.',
    },
  ],
  options: [],
  relatedSections: [
    {
      label: 'Strategy (top of this stage)',
      body: 'Only `reflective` and `structured_reflective` use this override. The other strategies don\'t call an LLM at all.',
    },
    {
      label: 'Stage 6 — Model override',
      body: 'Same mechanism, different stage. Stage 6 owns the main LLM call; Stage 18 owns the memory LLM call. Set both — main on capable model, memory on cheap model.',
    },
    {
      label: 'Stage 7 — Token / Calculator',
      body: 'Memory model calls show up in `state.token_usage` like main calls. If you want to track memory cost separately, use Stage 7\'s `detailed` tracker — the breakdown will show per-iteration which call was the memory call.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/core/stage.py:Stage.resolve_model_config',
};

const ko: SectionHelpContent = {
  title: '메모리 모델 (Memory model)',
  summary:
    '18단계의 단계별 \`model_override\`. \`reflective\` 와 \`structured_reflective\` strategy 가 LLM 주도 인사이트 추출에 사용. 평범한 \`append_only\` 와 \`no_memory\` strategy 는 LLM 호출 안 하고 이 섹션 무시.',
  whatItDoes: `18단계의 reflective strategy 들은 인사이트 추출을 위해 턴당 LLM 호출. 여기 override 없이 그 호출이 파이프라인의 기본 모델 사용 — 보통 낭비, 인사이트 추출이 메인 에이전트의 reasoning 보다 훨씬 단순한 작업이므로.

Override 메커니즘은 6단계와 동일 — \`Stage.resolve_model_config\` 가 \`entry.model_override\` 를 파이프라인 기본 위에 layer. 메모리의 옳은 패턴:

- 메인 에이전트는 reasoning 품질 위해 Claude Opus / Sonnet
- 메모리는 인사이트 추출 위해 Claude Haiku / 더 싼 것 (10× 더 쌈, 이 작업의 품질 페널티 무시할 수 있음)

Strategy 가 사용 안 하면 토글이 숨김 / inert. \`append_only\` / \`no_memory\` 선택 → 모델 섹션이 순전히 정보용, LLM 호출 안 일어나므로.`,
  configFields: [
    {
      name: 'model_override.model',
      label: '모델',
      type: 'string',
      description:
        '18단계의 LLM 호출만 위한 모델 override. 싼 모델 선택 — 인사이트 추출이 메인 에이전트와 같은 reasoning 능력 필요 없음.',
    },
    {
      name: 'model_override.system_prompt',
      label: '시스템 프롬프트',
      type: 'string',
      description:
        '단계별 시스템 프롬프트. Reflective strategy 가 인사이트 추출용 자체 내부 프롬프트 가짐; 이 override 가 그것을 REPLACE. 추출 스타일 커스터마이즈 필요할 때만 사용 — 보통 기본값으로 둠.',
    },
    {
      name: 'model_override.max_tokens',
      label: 'Max tokens',
      type: 'integer',
      description:
        '인사이트 추출 출력의 cap. 인사이트는 보통 짧음 — 500-1000 토큰이면 충분.',
    },
    {
      name: 'model_override.temperature',
      label: 'Temperature',
      type: 'number',
      description:
        '인사이트 추출에 low temperature (0–0.3) 가 보통 맞음 — 일관된, 결정적 추출 원함, 창의성 아님.',
    },
  ],
  options: [],
  relatedSections: [
    {
      label: '전략 (이 단계의 맨 위)',
      body: '`reflective` 와 `structured_reflective` 만 이 override 사용. 다른 strategy 는 LLM 호출 전혀 안 함.',
    },
    {
      label: '6단계 — 모델 오버라이드',
      body: '같은 메커니즘, 다른 단계. 6단계가 메인 LLM 호출 소유; 18단계가 메모리 LLM 호출 소유. 둘 다 설정 — 메인은 능력 있는 모델, 메모리는 싼 모델.',
    },
    {
      label: '7단계 — Token / Calculator',
      body: '메모리 모델 호출이 `state.token_usage` 에 메인 호출처럼 나타남. 메모리 비용을 별도로 추적하려면 7단계의 `detailed` tracker 사용 — 분해가 반복별로 어느 호출이 메모리 호출이었는지 보여줌.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/core/stage.py:Stage.resolve_model_config',
};

export const stage18ModelHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
