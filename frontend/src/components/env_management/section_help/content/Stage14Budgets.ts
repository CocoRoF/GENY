/**
 * Help content for Stage 14 → Pipeline-level budgets section.
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Pipeline budgets',
  summary:
    "Three pipeline-level ceilings: `max_iterations`, `cost_budget_usd`, and `context_window_budget`. These live on `manifest.pipeline` (not on Stage 14's entry) and are read by Stage 4 guards, Stage 16 controllers, and Stage 2's compactor trigger.",
  whatItDoes: `Despite living in Stage 14's curated UI, these are **pipeline-level fields** — they affect every stage that consults them, not just Stage 14. The reason they live here is purely UX: Stage 14 is the "evaluation" stage, and budget enforcement is conceptually evaluation logic.

The three knobs:

- **\`max_iterations\`** — pipeline-wide cap on \`state.iteration\`. Read by Stage 4 (\`iteration\` guard, when \`max_iterations\` isn't overridden per-stage) and Stage 16 (loop controllers).
- **\`cost_budget_usd\`** — pipeline-wide cap on \`state.total_cost_usd\`. Read by Stage 4 (\`cost_budget\` guard) and \`budget_aware\` / \`multi_dim_budget\` controllers in Stage 16.
- **\`context_window_budget\`** — model-specific token ceiling. Read by Stage 2's compactor trigger (80% threshold) and Stage 4's \`token_budget\` guard.

**These ceilings only fire if the relevant stages run.** Disabling Stage 4 or Stage 7 (Token) silently disables enforcement.`,
  options: [],
  configFields: [
    {
      name: 'pipeline.max_iterations',
      label: 'Max iterations',
      type: 'integer',
      default: '50',
      description:
        'Stored at `manifest.pipeline.max_iterations`. Per-stage Stage 4 `iteration` guard can override this with a smaller cap; the override wins. The cap is exclusive — `max_iterations: 50` allows iterations 0..49.',
    },
    {
      name: 'pipeline.cost_budget_usd',
      label: 'Cost budget (USD)',
      type: 'number',
      default: '10.0',
      description:
        'Stored at `manifest.pipeline.cost_budget_usd`. Stage 4\'s `cost_budget` guard reads this when `max_cost_usd` is null on the guard. Without Stage 7 (Token) running, `state.total_cost_usd` stays at 0 and this never fires.',
    },
    {
      name: 'pipeline.context_window_budget',
      label: 'Context window budget',
      type: 'integer',
      default: '200000',
      description:
        'Stored at `manifest.pipeline.context_window_budget`. Set this to your model\'s actual context window (200K for Claude 4.x, 128K for GPT-4o, etc.). Stage 2 starts compacting at 80% of this; Stage 4\'s `token_budget` guard rejects when free space drops below `min_remaining_tokens`.',
    },
  ],
  relatedSections: [
    {
      label: 'Strategy (next section in this stage)',
      body: 'Stage 14 also has its own strategy slot for convergence / retry patterns. The budget knobs above are pipeline-wide; the strategy slot is per-Stage-14.',
    },
    {
      label: 'Stage 4 — guards',
      body: 'Most enforcement happens at Stage 4. Pipeline budgets are the *defaults*; per-guard `max_*` fields can override them per-stage.',
    },
    {
      label: 'Stage 16 — Loop controllers',
      body: '`budget_aware` and `multi_dim_budget` controllers read the same pipeline budgets to decide whether to loop again. Different layer, same numbers.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/core/environment.py:PipelineConfig',
};

const ko: SectionHelpContent = {
  title: '파이프라인 예산 (Pipeline budgets)',
  summary:
    '세 가지 파이프라인 레벨 ceiling: \`max_iterations\`, \`cost_budget_usd\`, \`context_window_budget\`. 14단계 entry 가 아닌 \`manifest.pipeline\` 에 살고, 4단계 guard, 16단계 컨트롤러, 2단계 compactor trigger 가 읽음.',
  whatItDoes: `14단계의 curated UI 에 있음에도 이들은 **파이프라인 레벨 필드** — 14단계만이 아닌 그것을 참조하는 모든 단계에 영향. 여기 있는 이유는 순전히 UX: 14단계가 "평가" 단계, 예산 강제가 개념적으로 평가 로직.

세 knob:

- **\`max_iterations\`** — \`state.iteration\` 의 파이프라인 전역 cap. 4단계 (\`iteration\` guard, \`max_iterations\` 가 단계별로 override 안 될 때) 와 16단계 (loop 컨트롤러) 가 읽음.
- **\`cost_budget_usd\`** — \`state.total_cost_usd\` 의 파이프라인 전역 cap. 4단계 (\`cost_budget\` guard) 와 16단계의 \`budget_aware\` / \`multi_dim_budget\` 컨트롤러가 읽음.
- **\`context_window_budget\`** — 모델별 토큰 ceiling. 2단계의 compactor trigger (80% 임계) 와 4단계의 \`token_budget\` guard 가 읽음.

**이 ceiling 들은 관련 단계가 실행될 때만 발화.** 4단계 또는 7단계 (Token) 비활성화는 강제를 silent 하게 비활성화.`,
  options: [],
  configFields: [
    {
      name: 'pipeline.max_iterations',
      label: '최대 반복 수',
      type: 'integer',
      default: '50',
      description:
        '`manifest.pipeline.max_iterations` 에 저장. 단계별 4단계 `iteration` guard 가 더 작은 cap 으로 이를 override 가능; override 가 이김. cap 은 exclusive — `max_iterations: 50` 은 반복 0..49 허용.',
    },
    {
      name: 'pipeline.cost_budget_usd',
      label: '비용 예산 (USD)',
      type: 'number',
      default: '10.0',
      description:
        '`manifest.pipeline.cost_budget_usd` 에 저장. 4단계의 `cost_budget` guard 가 guard 의 `max_cost_usd` 가 null 일 때 이것 읽음. 7단계 (Token) 실행 없이 `state.total_cost_usd` 는 0 으로 유지되고 이는 절대 발화 안 함.',
    },
    {
      name: 'pipeline.context_window_budget',
      label: '컨텍스트 윈도우 예산',
      type: 'integer',
      default: '200000',
      description:
        '`manifest.pipeline.context_window_budget` 에 저장. 모델의 실제 컨텍스트 윈도우로 설정 (Claude 4.x 는 200K, GPT-4o 는 128K, 등). 2단계가 이것의 80% 에서 압축 시작; 4단계의 `token_budget` guard 가 free space 가 `min_remaining_tokens` 아래로 떨어지면 거부.',
    },
  ],
  relatedSections: [
    {
      label: '전략 (이 단계의 다음 섹션)',
      body: '14단계는 수렴 / 재시도 패턴을 위한 자체 strategy 슬롯도 있음. 위 예산 knob 들은 파이프라인 전역; strategy 슬롯은 14단계별.',
    },
    {
      label: '4단계 — guards',
      body: '대부분의 강제가 4단계에서 일어남. 파이프라인 예산은 *기본값*; per-guard `max_*` 필드가 그것을 단계별로 override 가능.',
    },
    {
      label: '16단계 — Loop 컨트롤러',
      body: '`budget_aware` 와 `multi_dim_budget` 컨트롤러가 같은 파이프라인 예산을 읽어 다시 루프할지 결정. 다른 레이어, 같은 숫자.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/core/environment.py:PipelineConfig',
};

export const stage14BudgetsHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
