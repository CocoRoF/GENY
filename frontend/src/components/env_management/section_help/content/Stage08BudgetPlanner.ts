/**
 * Help content for Stage 8 → Budget planner slot.
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Thinking budget planner',
  summary:
    "Decides how many thinking tokens this turn gets. Runs **before the API call** — Stage 6 reads `state.thinking_budget_tokens` when building its `ModelConfig`, so the planner's number directly controls how much the LLM is allowed to think.",
  whatItDoes: `\`state.thinking_budget_tokens\` is what Stage 6 sends as \`thinking_budget\` to the LLM. The planner's job is to decide that number per turn:

\`\`\`
state.thinking_budget_tokens = planner.plan(state)
state.add_event("think.budget_applied", {from, to, planner})
\`\`\`

\`state.thinking_enabled\` is also a gate — when false, the planner is bypassed entirely. So the budget only matters for thinking-capable models with thinking turned on at the pipeline level.

**Static vs adaptive** is the central trade-off:

- **Static** is predictable. Same budget every turn. Easy to reason about.
- **Adaptive** sizes the budget from cheap heuristics (prompt size, tool presence, reflection flag). Costs more on hard turns, less on easy ones.

For pipelines where every turn is similar, static wins on simplicity. For mixed workloads (some turns are simple Q&A, some are tool-heavy reasoning), adaptive can save tokens overall.`,
  options: [
    {
      id: 'static',
      label: 'Static',
      description: `Always returns the same fixed number. \`plan(state)\` ignores \`state\` entirely and returns \`budget_tokens\`.

The default. \`budget_tokens\` is runtime-tunable via \`strategy_configs.budget_planner.budget_tokens\`.`,
      bestFor: [
        'Pipelines where every turn is roughly the same shape',
        'Cost-predictable workloads — a fixed budget makes per-turn cost calculable',
        'Default for new pipelines — switch to adaptive only when you have data showing it helps',
      ],
      avoidWhen: [
        'Mixed workloads where some turns are trivial and some are reasoning-heavy — static over-spends on the trivial ones, under-spends on the hard ones',
      ],
      config: [
        {
          name: 'budget_tokens',
          label: 'Budget tokens',
          type: 'integer',
          default: '10,000',
          description:
            'Fixed thinking budget per turn. 10K is a reasonable starting point for Claude\'s extended thinking — enough for multi-step reasoning, not enough to dominate the response budget.',
        },
      ],
      gotchas: [
        'Budget is a **cap**, not a target. The model may use less. Setting `budget_tokens: 50000` doesn\'t mean every turn costs 50K thinking tokens — it means up to 50K when needed.',
        'The model\'s `max_tokens` (output budget) is separate. Thinking budget is in addition to that — total token spend per turn = thinking + output.',
      ],
      codeRef:
        'geny-executor / s08_think/artifact/default/budget.py:StaticThinkingBudget',
    },
    {
      id: 'adaptive',
      label: 'Adaptive',
      description: `Heuristic budget sizing. Starts from \`base_budget\` and adds:

- \`tools_bonus\` when \`state.tools\` is non-empty (tool-use turns benefit from more reasoning to plan tool sequences)
- \`reflection_bonus\` when \`state.metadata["needs_reflection"]\` is set (Stage 15 HITL or evaluator strategies can flag this)
- \`size_step_bonus\` per \`size_step_chars\` of prompt characters (longer prompts → more reasoning room)

Final value is clamped to \`[min_budget, max_budget]\`.`,
      bestFor: [
        'Mixed workloads — simple chitchat gets `base_budget`, hard tool-using turns get `base + tools_bonus + size_steps`',
        'Cost-aware agents — adaptive can save 30-50% of thinking tokens vs always-on max',
        'Long-running agents where prompt size grows — automatically scales the budget',
      ],
      avoidWhen: [
        'You need predictable per-turn cost — adaptive\'s cost varies turn-to-turn',
        'Your pipeline doesn\'t set `state.metadata.needs_reflection` ever — the reflection_bonus is dead weight',
      ],
      config: [
        {
          name: 'base_budget',
          label: 'Base budget',
          type: 'integer',
          default: '4,000',
          description:
            'Starting budget before bonuses. Smaller than static\'s default because adaptive expects to *grow* it for hard turns.',
        },
        {
          name: 'min_budget',
          label: 'Min budget',
          type: 'integer',
          default: '2,000',
          description:
            'Lower clamp — even if heuristics drop the budget low, this floor protects basic reasoning capability.',
        },
        {
          name: 'max_budget',
          label: 'Max budget',
          type: 'integer',
          default: '24,000',
          description:
            'Upper clamp — keeps adaptive from runaway growth on very long prompts.',
        },
        {
          name: 'tools_bonus',
          label: 'Tools bonus',
          type: 'integer',
          default: '4,000',
          description:
            'Added when `state.tools` is non-empty. Tool-use turns benefit from more thinking — the model has to plan call sequences.',
        },
        {
          name: 'reflection_bonus',
          label: 'Reflection bonus',
          type: 'integer',
          default: '4,000',
          description:
            'Added when `state.metadata.needs_reflection` is truthy. Set by Stage 15 (HITL) or evaluator strategies as a signal "this turn requires extra care".',
        },
      ],
      gotchas: [
        '`size_step_chars` and `size_step_bonus` are tunable but NOT exposed in the curated UI today (they\'re in the executor\'s ConfigSchema but the curated form skips them — Advanced has them).',
        'If `state.thinking_enabled` is false, none of this runs — the planner is bypassed by Stage 8.',
      ],
      codeRef:
        'geny-executor / s08_think/artifact/default/budget.py:AdaptiveThinkingBudget',
    },
  ],
  relatedSections: [
    {
      label: 'Thinking processor (other slot in this stage)',
      body: 'The processor handles thinking *output*; the planner handles thinking *input* budget. Both run in Stage 8 but at different points (processor after API, planner before).',
    },
    {
      label: 'Stage 6 — API',
      body: 'Stage 6 reads `state.thinking_budget_tokens` when constructing the request. Without a planner running, the budget stays at whatever the pipeline default was — usually 0, meaning thinking is effectively disabled.',
    },
    {
      label: 'Stage 15 — HITL',
      body: '`state.metadata.needs_reflection` is what triggers `adaptive`\'s reflection_bonus. Stage 15\'s timeout / requester strategies set this flag when a human-in-the-loop event suggests the next turn needs more care.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s08_think/artifact/default/budget.py',
};

const ko: SectionHelpContent = {
  title: 'Thinking 예산 플래너',
  summary:
    '이번 턴이 받을 thinking 토큰 수 결정. **API 호출 전** 실행 — 6단계가 \`ModelConfig\` 빌드 시 \`state.thinking_budget_tokens\` 를 읽으므로, 플래너의 숫자가 LLM 이 얼마나 thinking 할 수 있는지 직접 제어.',
  whatItDoes: `\`state.thinking_budget_tokens\` 가 6단계가 LLM 에 \`thinking_budget\` 으로 보내는 것. 플래너의 일은 그 숫자를 턴별로 결정:

\`\`\`
state.thinking_budget_tokens = planner.plan(state)
state.add_event("think.budget_applied", {from, to, planner})
\`\`\`

\`state.thinking_enabled\` 도 게이트 — false 일 때 플래너가 통째로 우회. 그래서 예산은 thinking 가능한 모델에 파이프라인 레벨에서 thinking 이 켜져있을 때만 중요.

**Static vs adaptive** 가 중심 trade-off:

- **Static** 은 예측 가능. 매 턴 같은 예산. 추론 쉬움.
- **Adaptive** 는 cheap 휴리스틱 (프롬프트 크기, 도구 존재, reflection 플래그) 으로 예산 사이즈. 어려운 턴에는 더 비싸고 쉬운 턴에는 덜.

매 턴이 비슷한 파이프라인에는 static 이 단순함으로 이김. 혼합 워크로드 (어떤 턴은 단순 Q&A, 어떤 턴은 도구 무거운 reasoning) 에는 adaptive 가 전체적으로 토큰 절약 가능.`,
  options: [
    {
      id: 'static',
      label: 'Static',
      description: `항상 같은 고정 숫자 반환. \`plan(state)\` 가 \`state\` 를 완전히 무시하고 \`budget_tokens\` 반환.

기본값. \`budget_tokens\` 는 \`strategy_configs.budget_planner.budget_tokens\` 로 런타임 튜닝 가능.`,
      bestFor: [
        '매 턴이 대략 같은 모양인 파이프라인',
        '비용 예측 가능 워크로드 — 고정 예산이 턴별 비용을 계산 가능하게 함',
        '새 파이프라인의 기본값 — adaptive 가 도움된다는 데이터가 있을 때만 전환',
      ],
      avoidWhen: [
        '어떤 턴은 trivial 하고 어떤 턴은 reasoning 무거운 혼합 워크로드 — static 이 trivial 에 over-spend, hard 에 under-spend',
      ],
      config: [
        {
          name: 'budget_tokens',
          label: '예산 토큰',
          type: 'integer',
          default: '10,000',
          description:
            '턴별 고정 thinking 예산. 10K 는 Claude 의 extended thinking 시작점으로 합리적 — 멀티 스텝 reasoning 에는 충분, 응답 예산을 dominate 할 만큼은 아님.',
        },
      ],
      gotchas: [
        '예산은 **cap**, 목표가 아님. 모델은 더 적게 쓸 수 있음. `budget_tokens: 50000` 설정이 매 턴 50K thinking 토큰 비용 의미가 아님 — 필요할 때 최대 50K.',
        '모델의 `max_tokens` (출력 예산) 은 별도. Thinking 예산은 그것에 추가 — 턴당 총 토큰 사용 = thinking + output.',
      ],
      codeRef:
        'geny-executor / s08_think/artifact/default/budget.py:StaticThinkingBudget',
    },
    {
      id: 'adaptive',
      label: 'Adaptive',
      description: `휴리스틱 예산 사이징. \`base_budget\` 에서 시작하고 추가:

- \`tools_bonus\` — \`state.tools\` 가 비어있지 않을 때 (tool-use 턴은 도구 시퀀스를 계획하기 위한 더 많은 reasoning 에서 이익)
- \`reflection_bonus\` — \`state.metadata["needs_reflection"]\` 이 설정될 때 (15단계 HITL 이나 evaluator 전략이 플래그)
- \`size_step_bonus\` — 프롬프트 문자의 \`size_step_chars\` 마다 (긴 프롬프트 → 더 많은 reasoning 여유)

최종 값은 \`[min_budget, max_budget]\` 으로 clamp.`,
      bestFor: [
        '혼합 워크로드 — 단순 잡담은 `base_budget`, 도구 사용 어려운 턴은 `base + tools_bonus + size_steps`',
        '비용 인식 에이전트 — adaptive 가 always-on max 대비 thinking 토큰 30-50% 절약 가능',
        '프롬프트 크기가 자라는 장기 에이전트 — 자동으로 예산 scale',
      ],
      avoidWhen: [
        '예측 가능한 턴별 비용이 필요할 때 — adaptive 의 비용은 턴마다 변함',
        '파이프라인이 `state.metadata.needs_reflection` 을 절대 설정하지 않을 때 — reflection_bonus 가 dead weight',
      ],
      config: [
        {
          name: 'base_budget',
          label: '기본 예산',
          type: 'integer',
          default: '4,000',
          description:
            '보너스 전 시작 예산. static 의 기본값보다 작음 — adaptive 는 어려운 턴에 *증가*시킬 것을 예상하기 때문.',
        },
        {
          name: 'min_budget',
          label: '최소 예산',
          type: 'integer',
          default: '2,000',
          description:
            '하한 clamp — 휴리스틱이 예산을 낮게 떨어뜨려도 이 floor 가 기본 reasoning 능력 보호.',
        },
        {
          name: 'max_budget',
          label: '최대 예산',
          type: 'integer',
          default: '24,000',
          description:
            '상한 clamp — 매우 긴 프롬프트에서 adaptive 의 폭주 성장 방지.',
        },
        {
          name: 'tools_bonus',
          label: '도구 보너스',
          type: 'integer',
          default: '4,000',
          description:
            '`state.tools` 가 비어있지 않을 때 추가. Tool-use 턴은 더 많은 thinking 에서 이익 — 모델이 호출 시퀀스를 계획해야 함.',
        },
        {
          name: 'reflection_bonus',
          label: '리플렉션 보너스',
          type: 'integer',
          default: '4,000',
          description:
            '`state.metadata.needs_reflection` 이 truthy 일 때 추가. 15단계 (HITL) 나 evaluator 전략이 "이 턴은 추가 주의 필요" 신호로 설정.',
        },
      ],
      gotchas: [
        '`size_step_chars` 와 `size_step_bonus` 는 튜닝 가능하지만 오늘 큐레이션된 UI 에 노출 안 됨 (실행기의 ConfigSchema 에 있지만 큐레이션된 폼이 skip — Advanced 에 있음).',
        '`state.thinking_enabled` 가 false 면 이 중 아무것도 실행 안 됨 — 플래너가 8단계에 의해 우회.',
      ],
      codeRef:
        'geny-executor / s08_think/artifact/default/budget.py:AdaptiveThinkingBudget',
    },
  ],
  relatedSections: [
    {
      label: 'Thinking 프로세서 (이 단계의 다른 슬롯)',
      body: '프로세서는 thinking *출력* 을 처리; 플래너는 thinking *입력* 예산을 처리. 둘 다 8단계에서 실행되지만 다른 시점 (프로세서는 API 후, 플래너는 전).',
    },
    {
      label: '6단계 — API',
      body: '6단계가 요청 구성 시 `state.thinking_budget_tokens` 를 읽음. 플래너 실행 없이 예산은 파이프라인 기본값 그대로 — 보통 0, thinking 이 사실상 비활성화 의미.',
    },
    {
      label: '15단계 — HITL',
      body: '`state.metadata.needs_reflection` 이 `adaptive` 의 reflection_bonus 를 trigger. 15단계의 timeout / requester 전략이 human-in-the-loop 이벤트가 다음 턴에 더 많은 주의 필요함을 시사할 때 이 플래그를 설정.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s08_think/artifact/default/budget.py',
};

export const stage08BudgetPlannerHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
