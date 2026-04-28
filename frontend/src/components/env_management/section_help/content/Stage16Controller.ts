/**
 * Help content for Stage 16 → Controller slot + max_turns / early_stop_on
 * stage.config.
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Loop controller',
  summary:
    "Decides whether the pipeline keeps looping for another turn or terminates. Reads `state.completion_signal` (set by Stage 9), `state.pending_tool_calls`, budget state, and configurable thresholds — writes `state.loop_decision`.",
  whatItDoes: `Stage 16 is the loop's decision point. After every turn it inspects the world and answers: \`continue\` (loop), \`complete\` (done, success), \`error\` (done, fail), or \`escalate\` (HITL or external).

The controller's outputs land on \`state.loop_decision\`. The pipeline runner reads that and either calls Stage 17/18/etc. for another turn or runs the post-loop tail (Stage 19 summary, Stage 20 persist, Stage 21 yield).

**Two stage.config knobs sit alongside the controller:**

- \`max_turns\` — hard ceiling. 0 = no cap. Applied independent of controller.
- \`early_stop_on\` — list of completion signals that immediately terminate the loop, regardless of controller logic. \`["BLOCKED", "ERROR"]\` means "stop on those even if the controller says continue".

Stage 16 also clears \`state.tool_results\` between turns, so each iteration starts with a clean tool-result slot.`,
  options: [
    {
      id: 'standard',
      label: 'Standard',
      description: `The default. Reads \`state.completion_signal\` and \`state.pending_tool_calls\`:

- \`COMPLETE\` signal → terminate (success)
- \`ERROR\` / \`BLOCKED\` signal → terminate (fail / escalate)
- pending tool calls → continue (loop runs Stage 10 to dispatch them)
- \`CONTINUE\` signal → continue
- otherwise → continue (default)

Works for ~90% of pipelines.`,
      bestFor: [
        'Default for new pipelines',
        'Tool-using chat agents — implicit "tool_use → continue" handles most cases',
        'Pipelines that have well-prompted agents emitting clear COMPLETE signals',
      ],
      avoidWhen: [
        'You need budget-aware termination — use `budget_aware`',
        'Single-turn-only pipelines — use `single_turn`',
      ],
      codeRef:
        'geny-executor / s16_loop/artifact/default/controllers.py:StandardLoopController',
    },
    {
      id: 'single_turn',
      label: 'Single turn',
      description: `Always returns \`complete\` after one turn, regardless of signals or pending tool calls. Stage 6 runs once, Stage 9 parses, Stage 21 formats, done.

Useful for pipelines where you want LLM output but not the loop overhead — classification, extraction, one-shot generation.`,
      bestFor: [
        'API endpoints — one request = one LLM call = one response',
        'Classification / extraction pipelines',
        'Test runs that should always terminate predictably',
      ],
      avoidWhen: [
        'You actually need tool-use loops — `single_turn` would call the LLM, get tool_use back, then terminate without dispatching',
      ],
      gotchas: [
        'If the model emits tool_use blocks, `single_turn` ignores them — Stage 10 still runs that turn but the next iteration never happens. The tool results sit in state but no LLM ever sees them.',
      ],
      codeRef:
        'geny-executor / s16_loop/artifact/default/controllers.py:SingleTurnController',
    },
    {
      id: 'budget_aware',
      label: 'Budget-aware',
      description: `Like \`standard\` but also checks token / cost budgets before allowing a continue:

- if \`state.total_cost_usd\` is within 95% of \`state.cost_budget_usd\` → terminate
- if estimated input tokens are within 90% of \`state.context_window_budget\` → terminate

The thresholds are conservative — better to terminate one turn early than to blow the budget.`,
      bestFor: [
        'Cost-sensitive workloads — graceful termination beats hard rejection at Stage 4',
        'Long-running agents where budget enforcement at the loop level is more humane than mid-turn rejection',
      ],
      avoidWhen: [
        'You want hard ceilings, not graceful degradation — Stage 4\'s budget guards are the right tool',
      ],
      codeRef:
        'geny-executor / s16_loop/artifact/default/controllers.py:BudgetAwareLoopController',
    },
    {
      id: 'multi_dim_budget',
      label: 'Multi-dim budget',
      description: `Pluggable budget dimensions: iteration count, total cost, total tokens, wall-clock time, total tool calls. Each dimension has its own threshold; any one crossing causes termination.

The most flexible loop controller — use when no single dimension is the limiting factor (e.g., "stop after 50 turns OR $5 OR 30 minutes wall-clock OR 100 tool calls").`,
      bestFor: [
        'Production agents where multiple constraints matter and any one being hit should stop the loop',
        'Pipelines run in long-form tasks — wall-clock alone often isn\'t enough; multi-dim catches drift along several axes',
      ],
      avoidWhen: [
        'You only care about one dimension — `budget_aware` (cost+tokens) or stage.config.max_turns alone is simpler',
      ],
      gotchas: [
        'Wall-clock dimension requires the host to set turn-start timestamps. Without that signal, wall-clock is always "0 elapsed".',
      ],
      codeRef:
        'geny-executor / s16_loop/artifact/default/controllers.py:MultiDimensionalBudgetController',
    },
  ],
  configFields: [
    {
      name: 'config.max_turns',
      label: 'Max turns',
      type: 'integer',
      default: '0',
      description:
        '0 = no cap. Otherwise hard ceiling — applied regardless of controller. Set this in addition to controller logic for a guaranteed terminating loop.',
    },
    {
      name: 'config.early_stop_on',
      label: 'Early-stop signals',
      type: 'list[string]',
      default: '[]',
      description:
        'Completion signals that immediately terminate the loop. e.g. `["BLOCKED", "ERROR"]` to abort on either. Applies BEFORE controller logic — the controller never sees those iterations.',
    },
  ],
  relatedSections: [
    {
      label: 'Stage 9 — Signal detector',
      body: 'Stage 16 reads `state.completion_signal` which Stage 9\'s detector sets. Without a working detector, Stage 16 only sees `NONE` and either default-continues or relies on max_turns to terminate.',
    },
    {
      label: 'Stage 4 — Guard',
      body: 'Stage 4 budgets reject *the next turn* before it runs. Stage 16 budgets terminate the loop *after the current turn*. Same numbers, different timing — Stage 4 is harder, Stage 16 is graceful.',
    },
    {
      label: 'Stage 14 — Pipeline budgets',
      body: 'Stage 14\'s pipeline-level budget knobs are what `budget_aware` and `multi_dim_budget` controllers read. Without those budgets set, both controllers behave like `standard`.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s16_loop/artifact/default/controllers.py',
};

const ko: SectionHelpContent = {
  title: '루프 컨트롤러 (Loop controller)',
  summary:
    '파이프라인이 다른 턴을 위해 계속 루프할지 종료할지 결정. \`state.completion_signal\` (9단계가 설정), \`state.pending_tool_calls\`, 예산 state, 구성 가능 임계값 읽음 — \`state.loop_decision\` 씀.',
  whatItDoes: `16단계는 루프의 결정 지점. 매 턴 후 세상을 inspect 하고 답변: \`continue\` (루프), \`complete\` (완료, 성공), \`error\` (완료, 실패), 또는 \`escalate\` (HITL 또는 외부).

컨트롤러 출력이 \`state.loop_decision\` 에 land. 파이프라인 runner 가 그것 읽고 다른 턴을 위해 17/18/등단계 호출하거나 post-loop tail (19단계 요약, 20단계 persist, 21단계 yield) 실행.

**컨트롤러 옆에 두 stage.config knob:**

- \`max_turns\` — hard ceiling. 0 = cap 없음. 컨트롤러와 독립 적용.
- \`early_stop_on\` — 컨트롤러 로직과 무관하게 즉시 루프 종료하는 완료 신호 리스트. \`["BLOCKED", "ERROR"]\` = "컨트롤러가 계속이라 해도 그것들에서 멈춤".

16단계는 또 턴 사이 \`state.tool_results\` 비움 — 각 반복이 깨끗한 tool-result 슬롯으로 시작.`,
  options: [
    {
      id: 'standard',
      label: '표준 (Standard)',
      description: `기본값. \`state.completion_signal\` 과 \`state.pending_tool_calls\` 읽음:

- \`COMPLETE\` 신호 → 종료 (성공)
- \`ERROR\` / \`BLOCKED\` 신호 → 종료 (실패 / 에스컬레이트)
- pending 도구 호출 → 계속 (루프가 10단계 실행해 dispatch)
- \`CONTINUE\` 신호 → 계속
- 그 외 → 계속 (기본)

파이프라인의 ~90% 에 작동.`,
      bestFor: [
        '새 파이프라인의 기본값',
        '도구 사용 채팅 에이전트 — 암시적 "tool_use → continue" 가 대부분 처리',
        '명확한 COMPLETE 신호 emit 하는 잘 prompt 된 에이전트의 파이프라인',
      ],
      avoidWhen: [
        '예산 인식 종료 필요할 때 — `budget_aware` 사용',
        '단일 턴만 파이프라인 — `single_turn` 사용',
      ],
      codeRef:
        'geny-executor / s16_loop/artifact/default/controllers.py:StandardLoopController',
    },
    {
      id: 'single_turn',
      label: '단일 턴 (Single turn)',
      description: `신호나 pending 도구 호출과 무관하게 한 턴 후 항상 \`complete\` 반환. 6단계가 한 번 실행, 9단계 파싱, 21단계 포맷, 끝.

LLM 출력은 원하지만 루프 오버헤드는 원치 않는 파이프라인에 유용 — 분류, 추출, 일회성 생성.`,
      bestFor: [
        'API 엔드포인트 — 한 요청 = 한 LLM 호출 = 한 응답',
        '분류 / 추출 파이프라인',
        '항상 예측 가능하게 종료해야 하는 테스트 실행',
      ],
      avoidWhen: [
        '실제로 도구 사용 루프 필요할 때 — `single_turn` 은 LLM 호출, tool_use 받음, 그 후 dispatch 없이 종료',
      ],
      gotchas: [
        '모델이 tool_use 블록 emit 하면 `single_turn` 은 무시 — 10단계가 그 턴에 실행되지만 다음 반복은 절대 안 일어남. 도구 결과가 state 에 있지만 어떤 LLM 도 못 봄.',
      ],
      codeRef:
        'geny-executor / s16_loop/artifact/default/controllers.py:SingleTurnController',
    },
    {
      id: 'budget_aware',
      label: '예산 인식 (Budget-aware)',
      description: `\`standard\` 와 같지만 continue 허용 전 토큰 / 비용 예산도 체크:

- \`state.total_cost_usd\` 가 \`state.cost_budget_usd\` 의 95% 이내 → 종료
- 추정 입력 토큰이 \`state.context_window_budget\` 의 90% 이내 → 종료

임계값은 보수적 — 예산 폭파보다 한 턴 일찍 종료가 나음.`,
      bestFor: [
        '비용 민감 워크로드 — 4단계의 hard 거부보다 graceful 종료',
        '루프 레벨 예산 강제가 턴 중 거부보다 인간적인 장기 에이전트',
      ],
      avoidWhen: [
        'Hard ceiling 원할 때, graceful degradation 아닌 — 4단계의 예산 guard 가 옳은 도구',
      ],
      codeRef:
        'geny-executor / s16_loop/artifact/default/controllers.py:BudgetAwareLoopController',
    },
    {
      id: 'multi_dim_budget',
      label: '다차원 예산 (Multi-dim budget)',
      description: `플러그형 예산 차원: 반복 카운트, 총 비용, 총 토큰, wall-clock 시간, 총 도구 호출. 각 차원이 자체 임계값; 어느 하나 crossing 이 종료 일으킴.

가장 유연한 루프 컨트롤러 — 단일 차원이 limiting factor 가 아닐 때 사용 (예: "50턴 OR $5 OR 30분 wall-clock OR 100 도구 호출 후 멈춤").`,
      bestFor: [
        '여러 제약이 중요하고 어느 하나라도 hit 되면 루프를 멈춰야 하는 프로덕션 에이전트',
        'long-form 작업의 파이프라인 — wall-clock 만으로는 충분치 않음; multi-dim 이 여러 축의 drift 잡음',
      ],
      avoidWhen: [
        '한 차원만 신경 쓸 때 — `budget_aware` (비용+토큰) 또는 stage.config.max_turns 만이 더 단순',
      ],
      gotchas: [
        'Wall-clock 차원은 호스트가 턴 시작 timestamp 설정 필요. 그 신호 없이 wall-clock 은 항상 "0 경과".',
      ],
      codeRef:
        'geny-executor / s16_loop/artifact/default/controllers.py:MultiDimensionalBudgetController',
    },
  ],
  configFields: [
    {
      name: 'config.max_turns',
      label: '최대 턴 수',
      type: 'integer',
      default: '0',
      description:
        '0 = cap 없음. 그 외에는 hard ceiling — 컨트롤러와 무관하게 적용. 보장된 종료 루프를 위해 컨트롤러 로직에 추가로 설정.',
    },
    {
      name: 'config.early_stop_on',
      label: '조기 종료 신호',
      type: 'list[string]',
      default: '[]',
      description:
        '루프를 즉시 종료하는 완료 신호. 예: 둘 중 하나에서 abort 하려면 `["BLOCKED", "ERROR"]`. 컨트롤러 로직 BEFORE 적용 — 컨트롤러는 그 반복들을 절대 못 봄.',
    },
  ],
  relatedSections: [
    {
      label: '9단계 — Signal detector',
      body: '16단계가 9단계의 detector 가 설정한 `state.completion_signal` 읽음. 작동 detector 없이 16단계는 `NONE` 만 보고 default-continue 하거나 종료에 max_turns 의존.',
    },
    {
      label: '4단계 — Guard',
      body: '4단계 예산이 *다음 턴*을 그것이 실행되기 전에 거부. 16단계 예산은 *현재 턴 후* 루프 종료. 같은 숫자, 다른 타이밍 — 4단계는 더 hard, 16단계는 graceful.',
    },
    {
      label: '14단계 — 파이프라인 예산',
      body: '14단계의 파이프라인 레벨 예산 knob 들이 `budget_aware` 와 `multi_dim_budget` 컨트롤러가 읽는 것. 그 예산들 설정 안 되면 둘 다 `standard` 처럼 동작.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s16_loop/artifact/default/controllers.py',
};

export const stage16ControllerHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
