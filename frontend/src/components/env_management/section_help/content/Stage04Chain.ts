/**
 * Help content for Stage 4 → Guards chain (the chain itself + per-guard
 * config).
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Guards chain',
  summary:
    "An ordered list of guard checks. Each guard inspects pipeline state and returns *pass* or *reject*. The first reject (in `fail_fast` mode) raises `GuardRejectError` and the turn is aborted before the LLM is called.",
  whatItDoes: `Stage 4 walks its chain top-to-bottom. Each guard sees the live \`PipelineState\` and answers a single question:

\`\`\`
result = guard.check(state)  → GuardResult(passed, message, action)
\`\`\`

\`action\` is usually \`"reject"\` (terminal) but can be \`"warn"\` (logged, turn continues). Reject raises \`GuardRejectError\` and aborts the turn — Stage 5 onwards does not run.

**The four built-in guards each watch a different thing on \`state\`:**

- \`token_budget\` → \`state.context_window_budget\` minus running token usage
- \`cost_budget\` → \`state.total_cost_usd\` against a per-stage or session-level cap
- \`iteration\` → \`state.iteration\` against a per-stage or session-level limit
- \`permission\` → \`state.pending_tool_calls\` against allow/block lists

**Order matters when \`fail_fast=true\`.** Cheaper checks first means you don't waste effort on expensive checks for already-rejected turns. The default order in the curated picker is intentional: token budget (cheapest, single integer compare) → cost budget → iteration → permission (loops over pending tool calls).`,
  options: [
    {
      id: 'token_budget',
      label: 'Token budget',
      description: `Reject when the context window can't fit the next API call. Compares \`state.token_usage.input_tokens + output_tokens\` against \`state.context_window_budget\`; if remaining headroom is below \`min_remaining_tokens\`, the guard rejects with \`"Token budget low: N remaining (min M)"\`.

This catches the case where Stage 2's compactor *should* have shrunk the prompt but couldn't — e.g., the user's input alone is already 100K tokens. Better to reject here than to crash on the LLM call.`,
      bestFor: [
        'Long-running sessions where prompt size can creep up despite Stage 2\'s compaction',
        'Multi-modal pipelines — an image-laden turn can blow the budget without the message-count compactor noticing',
        'Pipelines using small-context models (e.g., gpt-4o at 128K) where the floor matters',
      ],
      avoidWhen: [
        'You\'re using a very large context model and want to attempt the call regardless — the LLM will reject anyway, but at the cost of an API round-trip',
      ],
      config: [
        {
          name: 'min_remaining_tokens',
          label: 'Min remaining tokens',
          type: 'integer',
          default: '10,000',
          description:
            'Reject the turn when fewer than this many tokens are free in the context window. 10K covers a typical assistant response (~2K-4K) plus thinking budget plus headroom.',
        },
      ],
      gotchas: [
        '`state.context_window_budget` defaults to a model-specific value at pipeline construction. If your host doesn\'t set it, the guard compares against 0 — every turn looks like \"budget full\" and rejects.',
        'Guard reads `input_tokens + output_tokens`, not actual prompt characters. A turn with high cache_read still counts toward `input_tokens` for budget purposes.',
      ],
      codeRef:
        'geny-executor / s04_guard/artifact/default/guards.py:TokenBudgetGuard',
    },
    {
      id: 'cost_budget',
      label: 'Cost budget',
      description: `Reject when cumulative session cost exceeds a cap. Compares \`state.total_cost_usd\` against the configured \`max_cost_usd\` if set, otherwise \`state.cost_budget_usd\` (session-level fallback).

If neither is set, the guard always passes — useful as a no-op placeholder slot you can flip on later by setting \`max_cost_usd\` in the manifest.`,
      bestFor: [
        'Public-facing agents where runaway tool loops could rack up a 10x cost on a runaway turn',
        'Per-tenant cost ceilings — set max_cost_usd from the manifest, override per tenant via session-level state.cost_budget_usd',
        'CI / test pipelines — explicit per-run cap protects against test infinite loops',
      ],
      avoidWhen: [
        'You don\'t track cost — without Stage 7 (Token) running, `state.total_cost_usd` stays at 0 and this guard never fires',
      ],
      config: [
        {
          name: 'max_cost_usd',
          label: 'Max cost (USD)',
          type: 'number',
          default: 'null',
          description:
            'Per-stage cap. When `null` (default), falls back to `state.cost_budget_usd` (session-level). When both are null, the guard always passes — explicit opt-in only.',
        },
      ],
      gotchas: [
        '**Cost is computed by Stage 7 (Token), not Stage 6.** If Stage 7 is disabled or its calculator slot is mis-wired, `state.total_cost_usd` stays at 0 and this guard never fires.',
        'The check is `>=`, not `>`. Setting `max_cost_usd: 1.00` and accumulating exactly $1.00 will reject — set slightly above your true ceiling if you want $1.00 to be allowed.',
      ],
      codeRef:
        'geny-executor / s04_guard/artifact/default/guards.py:CostBudgetGuard',
    },
    {
      id: 'iteration',
      label: 'Iteration limit',
      description: `Reject when \`state.iteration\` reaches \`max_iterations\` (or the session-level fallback \`state.max_iterations\`). The most basic infinite-loop protection.

Stage 16 (Loop) also checks iteration counts but does so per-loop-decision — Stage 4 catches the count *before* the turn even starts, so a misbehaving controller can't sneak past it.`,
      bestFor: [
        'Tool-heavy agents that may chain tool calls indefinitely',
        'Agent-type pipelines (Stage 12 evaluator / delegate orchestrators) where sub-agents could recursively dispatch',
        'Defense-in-depth alongside Stage 16 — different check points, different failure modes',
      ],
      avoidWhen: [
        'Single-turn pipelines (`pipeline.single_turn=True`). Stage 16 forces termination after one turn anyway.',
      ],
      config: [
        {
          name: 'max_iterations',
          label: 'Max iterations',
          type: 'integer',
          default: 'null',
          description:
            'Per-stage cap. When `null`, falls back to `state.max_iterations` (session-level). The check is `state.iteration >= limit` — set the cap to the *maximum allowed iteration count* (turn 0 through turn N-1 = N iterations).',
        },
      ],
      gotchas: [
        'Off-by-one trap: `max_iterations: 10` rejects on iteration 10, not iteration 11. Iterations are 0-indexed; the cap is **exclusive of the rejected turn**.',
        '`state.iteration` is incremented by the loop, not by Stage 4. If your pipeline doesn\'t use Stage 16 (or uses `single_turn` controller), iteration stays at 0 forever and this guard is useless.',
      ],
      codeRef:
        'geny-executor / s04_guard/artifact/default/guards.py:IterationGuard',
    },
    {
      id: 'permission',
      label: 'Tool permission',
      description: `Reject when any pending tool call is in the blocklist or absent from the allowlist. Loops over \`state.pending_tool_calls\` (set by Stage 9 Parse from the LLM's tool_use blocks) and checks each \`tool_name\`.

Two list semantics:

- \`blocked_tools\` is *additive deny* — names in this list are always rejected
- \`allowed_tools\` is *exclusive allow* — when non-empty, **only** names in this list pass

Both empty = no restrictions. Set just one to do allow-list-only or block-list-only.`,
      bestFor: [
        'Sandboxed agents — only allow `read_file`, never allow `write_file` or `bash`',
        'Per-tenant tool restrictions — manifest-level block list for tools that customers shouldn\'t reach',
        'Model-on-trial pipelines — block dangerous tools while you evaluate a new model',
      ],
      avoidWhen: [
        'You\'re using Stage 11 (Tool review) — that\'s a richer per-call review chain. Stage 4\'s permission guard is cheap allow/block; Stage 11 does pattern matching, severity flagging, custom reviewers.',
      ],
      config: [
        {
          name: 'allowed_tools',
          label: 'Allowed tools',
          type: 'list[string]',
          default: '[]',
          description:
            'Empty = no allowlist filter (all tools allowed unless blocked). Non-empty = ONLY these tool names pass; everything else rejects.',
        },
        {
          name: 'blocked_tools',
          label: 'Blocked tools',
          type: 'list[string]',
          default: '[]',
          description:
            'Tool names always rejected, regardless of the allowlist. Block wins over allow when a name appears in both.',
        },
      ],
      gotchas: [
        'Lists hold **tool names as strings**, not glob patterns. `"read_*"` does NOT match `read_file` — it only matches the literal string `"read_*"`.',
        'The check loops over ALL pending calls. If the LLM emits 5 tool_use blocks and the 5th is blocked, the guard still rejects — but only after walking the first 4. Stage 11 has finer-grained review.',
      ],
      codeRef:
        'geny-executor / s04_guard/artifact/default/guards.py:PermissionGuard',
    },
  ],
  relatedSections: [
    {
      label: 'Guard stage settings (this stage)',
      body: 'fail_fast / max_chain_length — how the chain *behaves*. The chain *contents* are this section.',
    },
    {
      label: 'Stage 11 — Tool review',
      body: 'For tool calls, Stage 11 is richer than Stage 4\'s permission guard: regex pattern matching, severity levels, custom reviewer chains. Stage 4\'s permission is the cheap synchronous gate; Stage 11 is the considered review.',
    },
    {
      label: 'Stage 16 — Loop',
      body: 'Iteration / cost / token budgets get a second check at the loop layer. Stage 4 rejects this turn synchronously; Stage 16 decides whether to loop again after the LLM call.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s04_guard/artifact/default/guards.py',
};

const ko: SectionHelpContent = {
  title: '가드 체인 (Guards chain)',
  summary:
    '순서가 있는 guard 검사 리스트. 각 guard 가 파이프라인 state 를 inspect 하고 *pass* 또는 *reject* 를 반환. 첫 reject (\`fail_fast\` 모드에서) 가 \`GuardRejectError\` 를 발생시키고 LLM 호출 전에 턴이 중단됩니다.',
  whatItDoes: `4단계는 체인을 위에서 아래로 walk. 각 guard 는 라이브 \`PipelineState\` 를 보고 단일 질문에 답:

\`\`\`
result = guard.check(state)  → GuardResult(passed, message, action)
\`\`\`

\`action\` 은 보통 \`"reject"\` (terminal) 이지만 \`"warn"\` (로깅, 턴 계속) 일 수 있음. Reject 가 \`GuardRejectError\` 를 발생시키고 턴을 중단 — 5단계 이후는 실행되지 않음.

**4개 빌트인 guard 가 각각 \`state\` 의 다른 것을 감시:**

- \`token_budget\` → \`state.context_window_budget\` 빼기 누적 토큰 사용량
- \`cost_budget\` → \`state.total_cost_usd\` 를 단계별 또는 세션 레벨 cap 과 비교
- \`iteration\` → \`state.iteration\` 을 단계별 또는 세션 레벨 limit 과 비교
- \`permission\` → \`state.pending_tool_calls\` 를 allow/block 리스트와 비교

**\`fail_fast=true\` 일 때 순서가 중요.** 싸게 체크하는 것 먼저 = 이미 거부된 턴에 비싼 체크로 노력 낭비 안 함. 큐레이션된 picker 의 기본 순서는 의도적: token budget (가장 쌈, 단일 정수 비교) → cost budget → iteration → permission (대기 도구 호출에 대한 루프).`,
  options: [
    {
      id: 'token_budget',
      label: '토큰 예산 (Token budget)',
      description: `컨텍스트 윈도우가 다음 API 호출을 못 담을 때 거부. \`state.token_usage.input_tokens + output_tokens\` 를 \`state.context_window_budget\` 와 비교; 남은 여유가 \`min_remaining_tokens\` 미만이면 \`"Token budget low: N remaining (min M)"\` 로 거부.

이는 2단계의 compactor 가 프롬프트를 줄였*어야* 했지만 못한 경우를 잡음 — 예: 사용자 입력 자체가 이미 100K 토큰. 여기서 거부하는 게 LLM 호출에서 크래시하는 것보다 나음.`,
      bestFor: [
        '2단계 압축에도 불구하고 프롬프트 크기가 늘어날 수 있는 장기 세션',
        '멀티모달 파이프라인 — 이미지 가득한 턴이 메시지 카운트 compactor 가 알아채지 못한 채 예산을 날릴 수 있음',
        'floor 가 중요한 작은 컨텍스트 모델 (예: gpt-4o 128K) 을 쓰는 파이프라인',
      ],
      avoidWhen: [
        '매우 큰 컨텍스트 모델을 쓰고 어쨌든 호출을 시도하고 싶을 때 — LLM 이 어차피 거부하지만 API round-trip 비용을 지불',
      ],
      config: [
        {
          name: 'min_remaining_tokens',
          label: '최소 남은 토큰',
          type: 'integer',
          default: '10,000',
          description:
            '컨텍스트 윈도우에 이 토큰 수 미만이 free 일 때 턴을 거부. 10K 는 일반 어시스턴트 응답 (~2K-4K) + thinking 예산 + 여유 커버.',
        },
      ],
      gotchas: [
        '`state.context_window_budget` 는 파이프라인 구성 시 모델별 값으로 기본 설정. 호스트가 설정 안 하면 guard 가 0 과 비교 — 매 턴이 \"예산 full\" 처럼 보이고 거부.',
        'Guard 가 `input_tokens + output_tokens` 를 읽음, 실제 프롬프트 문자가 아님. 높은 cache_read 의 턴도 예산 목적의 `input_tokens` 에 카운트.',
      ],
      codeRef:
        'geny-executor / s04_guard/artifact/default/guards.py:TokenBudgetGuard',
    },
    {
      id: 'cost_budget',
      label: '비용 예산 (Cost budget)',
      description: `누적 세션 비용이 cap 을 초과할 때 거부. \`state.total_cost_usd\` 를 설정된 \`max_cost_usd\` (있으면), 그 외 \`state.cost_budget_usd\` (세션 레벨 fallback) 와 비교.

둘 다 설정 안 되면 guard 가 항상 통과 — 나중에 매니페스트에 \`max_cost_usd\` 를 설정해 켤 수 있는 no-op placeholder 슬롯으로 유용.`,
      bestFor: [
        '폭주하는 도구 루프가 폭주 턴에 10배 비용을 쌓을 수 있는 공개 에이전트',
        'tenant 별 비용 ceiling — 매니페스트에서 max_cost_usd 설정, tenant 별로 세션 레벨 state.cost_budget_usd 로 override',
        'CI / 테스트 파이프라인 — 명시적 per-run cap 이 테스트 무한 루프로부터 보호',
      ],
      avoidWhen: [
        '비용을 추적하지 않을 때 — 7단계 (Token) 실행 없이 `state.total_cost_usd` 는 0 으로 유지되고 이 guard 는 발화하지 않음',
      ],
      config: [
        {
          name: 'max_cost_usd',
          label: '최대 비용 (USD)',
          type: 'number',
          default: 'null',
          description:
            '단계별 cap. `null` (기본값) 일 때 `state.cost_budget_usd` (세션 레벨) 로 fallback. 둘 다 null 이면 guard 가 항상 통과 — 명시적 opt-in 만.',
        },
      ],
      gotchas: [
        '**비용은 6단계가 아닌 7단계 (Token) 가 계산.** 7단계가 비활성화되거나 calculator 슬롯이 잘못 wire 되면 `state.total_cost_usd` 는 0 으로 유지되고 이 guard 는 발화하지 않음.',
        '체크는 `>=`, `>` 가 아님. `max_cost_usd: 1.00` 으로 설정하고 정확히 $1.00 누적되면 거부 — $1.00 가 허용되길 원하면 진짜 ceiling 보다 약간 위로 설정.',
      ],
      codeRef:
        'geny-executor / s04_guard/artifact/default/guards.py:CostBudgetGuard',
    },
    {
      id: 'iteration',
      label: '반복 한계 (Iteration limit)',
      description: `\`state.iteration\` 이 \`max_iterations\` (또는 세션 레벨 fallback \`state.max_iterations\`) 에 도달할 때 거부. 가장 기본적인 무한 루프 보호.

16단계 (Loop) 도 반복 카운트를 체크하지만 루프 결정별로 — 4단계는 턴이 시작되기 *전*에 카운트를 잡으므로 잘못된 controller 가 통과 못 함.`,
      bestFor: [
        '도구 호출을 무한히 chain 할 수 있는 도구 중심 에이전트',
        'sub-agent 가 재귀적으로 dispatch 할 수 있는 agent 타입 파이프라인 (12단계 evaluator / delegate orchestrator)',
        '16단계와 함께 defense-in-depth — 다른 체크 지점, 다른 실패 모드',
      ],
      avoidWhen: [
        '단일 턴 파이프라인 (`pipeline.single_turn=True`). 16단계가 어차피 한 턴 후 종료를 강제.',
      ],
      config: [
        {
          name: 'max_iterations',
          label: '최대 반복 수',
          type: 'integer',
          default: 'null',
          description:
            '단계별 cap. `null` 일 때 `state.max_iterations` (세션 레벨) 로 fallback. 체크는 `state.iteration >= limit` — cap 을 *허용된 최대 반복 카운트* 로 설정 (턴 0 부터 턴 N-1 = N 반복).',
        },
      ],
      gotchas: [
        'Off-by-one trap: `max_iterations: 10` 은 반복 11 이 아닌 반복 10 에서 거부. 반복은 0-indexed; cap 은 **거부된 턴을 배제**.',
        '`state.iteration` 은 4단계가 아닌 루프가 증가시킴. 파이프라인이 16단계를 안 쓰거나 (`single_turn` controller 사용) 면 iteration 이 영원히 0 으로 유지되고 이 guard 는 쓸모없음.',
      ],
      codeRef:
        'geny-executor / s04_guard/artifact/default/guards.py:IterationGuard',
    },
    {
      id: 'permission',
      label: '도구 권한 (Tool permission)',
      description: `대기 중인 도구 호출 중 어느 것이라도 blocklist 에 있거나 allowlist 에 없을 때 거부. \`state.pending_tool_calls\` (9단계 Parse 가 LLM 의 tool_use 블록에서 설정) 를 루프하고 각 \`tool_name\` 을 체크.

두 가지 리스트 의미론:

- \`blocked_tools\` 는 *additive deny* — 이 리스트의 이름은 항상 거부
- \`allowed_tools\` 는 *exclusive allow* — 비어있지 않을 때 **이 리스트의 이름만** 통과

둘 다 비어있음 = 제약 없음. 하나만 설정해서 allow-list-only 또는 block-list-only 가능.`,
      bestFor: [
        '샌드박스 에이전트 — `read_file` 만 허용, `write_file` 이나 `bash` 는 절대 허용 안 함',
        'tenant 별 도구 제약 — 고객이 도달하면 안 되는 도구의 매니페스트 레벨 block 리스트',
        '시범 운용 모델 파이프라인 — 새 모델을 평가하는 동안 위험 도구 차단',
      ],
      avoidWhen: [
        '11단계 (Tool review) 를 쓰고 있을 때 — 그것이 더 풍부한 호출별 review 체인. 4단계의 permission guard 는 cheap allow/block; 11단계는 패턴 매칭, severity 플래깅, 커스텀 reviewer.',
      ],
      config: [
        {
          name: 'allowed_tools',
          label: '허용 도구',
          type: 'list[string]',
          default: '[]',
          description:
            '비어있음 = allowlist 필터 없음 (블록되지 않으면 모든 도구 허용). 비어있지 않음 = 이 도구 이름만 통과; 그 외는 거부.',
        },
        {
          name: 'blocked_tools',
          label: '차단 도구',
          type: 'list[string]',
          default: '[]',
          description:
            'allowlist 와 무관하게 항상 거부되는 도구 이름. 이름이 둘 다에 있으면 block 이 allow 를 이김.',
        },
      ],
      gotchas: [
        '리스트는 **도구 이름을 문자열로** 보유, glob 패턴이 아님. `"read_*"` 는 `read_file` 과 매칭 안 됨 — 리터럴 문자열 `"read_*"` 와만 매칭.',
        '체크는 모든 대기 호출을 루프. LLM 이 5개의 tool_use 블록을 emit 하고 5번째가 차단되면 guard 가 거부 — 하지만 처음 4개를 walk 한 후. 11단계가 더 세밀한 review.',
      ],
      codeRef:
        'geny-executor / s04_guard/artifact/default/guards.py:PermissionGuard',
    },
  ],
  relatedSections: [
    {
      label: '가드 단계 설정 (이 단계)',
      body: 'fail_fast / max_chain_length — 체인이 *어떻게 동작*할지. 체인의 *내용*은 이 섹션.',
    },
    {
      label: '11단계 — Tool review',
      body: '도구 호출에 대해 11단계는 4단계의 permission guard 보다 풍부: regex 패턴 매칭, severity 레벨, 커스텀 reviewer 체인. 4단계의 permission 은 cheap 동기 게이트; 11단계는 considered review.',
    },
    {
      label: '16단계 — Loop',
      body: '반복 / 비용 / 토큰 예산은 루프 레이어에서 두 번째 체크를 받음. 4단계는 이번 턴을 동기 거부; 16단계는 LLM 호출 후 다시 루프할지 결정.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s04_guard/artifact/default/guards.py',
};

export const stage04ChainHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
