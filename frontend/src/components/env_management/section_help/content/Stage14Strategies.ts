/**
 * Help content for Stage 14 → Strategy slots (convergence / retry).
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Evaluation strategies',
  summary:
    "Per-stage strategies for evaluation — convergence detection, retry decisions, evaluator dispatch. Distinct from the pipeline-level **budgets** above; these are stage-internal logic.",
  whatItDoes: `Stage 14 owns the "did this turn produce an acceptable result, or do we re-loop?" question (separately from Stage 16 which owns "should we loop AT ALL"). The strategies in this section are the levers for those decisions.

The exact slot list depends on the artifact you've picked — \`default\` ships convergence + retry slots; \`adaptive\` (an alternative artifact) adds adaptive strategy selection. The curated UI defers to \`StrategiesEditor\` here because the slot list is artifact-dependent and varies more than the typical Stage 14 user wants pinned in tile-form.

**For most pipelines this section is left at defaults.** Convergence / retry strategies become important only when you have:

- agent loops where output quality matters more than speed
- pipelines that re-prompt on failure with adjusted parameters
- evaluator-pattern setups (Stage 12 \`evaluator\` orchestrator) that depend on a Stage 14 verdict

**Inspect each impl in Advanced** if you're trying to understand what's available — the schemas are model-driven and the curated picker can't enumerate them at this level of depth.`,
  options: [],
  configFields: [],
  relatedSections: [
    {
      label: 'Pipeline budgets (previous section in this stage)',
      body: 'Pipeline budgets are global ceilings. Strategies are per-stage logic — they decide what to do *within* the budget the pipeline gives them.',
    },
    {
      label: 'Stage 12 — Evaluator orchestrator',
      body: 'Stage 12\'s evaluator pattern produces candidate outputs; Stage 14 may then re-evaluate after the loop. They\'re complementary — Stage 12 = intra-turn, Stage 14 = post-turn.',
    },
    {
      label: 'Stage 16 — Loop',
      body: 'Stage 14 sets `state.metadata` flags that Stage 16\'s controllers can key off (e.g., `needs_retry`). Without Stage 14 running, those flags stay default.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s14_evaluate/',
};

const ko: SectionHelpContent = {
  title: '평가 전략 (Strategies)',
  summary:
    '평가를 위한 단계별 전략 — 수렴 감지, 재시도 결정, evaluator dispatch. 위의 파이프라인 레벨 **예산** 과 별개; 이들은 단계 내부 로직.',
  whatItDoes: `14단계가 "이 턴이 수용 가능한 결과를 생산했나, 아니면 재루프?" 질문을 소유 (16단계의 "루프할까 말까" 와 별개). 이 섹션의 전략들이 그 결정의 lever.

정확한 슬롯 리스트는 선택한 artifact 에 따라 달림 — \`default\` 가 수렴 + 재시도 슬롯 ship; \`adaptive\` (대체 artifact) 는 적응형 전략 선택 추가. 큐레이션된 UI 가 여기서 \`StrategiesEditor\` 에 defer — 슬롯 리스트가 artifact 의존이고 일반 14단계 사용자가 tile 형태로 pin 하길 원하는 것보다 더 변하기 때문.

**대부분의 파이프라인은 이 섹션을 기본값으로 둠.** 수렴 / 재시도 전략은 다음이 있을 때만 중요:

- 출력 품질이 속도보다 중요한 에이전트 루프
- 실패 시 조정된 파라미터로 re-prompt 하는 파이프라인
- 14단계 verdict 에 의존하는 evaluator-pattern setup (12단계 \`evaluator\` 오케스트레이터)

**무엇이 사용 가능한지 이해하려면 Advanced 에서 각 impl 를 inspect** — 스키마가 모델 주도이고 큐레이션된 picker 가 이 깊이로 enumerate 못 함.`,
  options: [],
  configFields: [],
  relatedSections: [
    {
      label: '파이프라인 예산 (이 단계의 이전 섹션)',
      body: '파이프라인 예산은 글로벌 ceiling. 전략은 단계별 로직 — 파이프라인이 주는 예산 *내*에서 무엇을 할지 결정.',
    },
    {
      label: '12단계 — Evaluator 오케스트레이터',
      body: '12단계의 evaluator 패턴이 candidate 출력 생산; 14단계가 루프 후 재평가 가능. 보완적 — 12단계 = 턴 내, 14단계 = 턴 후.',
    },
    {
      label: '16단계 — Loop',
      body: '14단계가 16단계의 컨트롤러가 key 로 사용할 수 있는 `state.metadata` 플래그 설정 (예: `needs_retry`). 14단계 실행 없이 그 플래그들은 기본값으로 유지.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s14_evaluate/',
};

export const stage14StrategiesHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
