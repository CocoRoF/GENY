/**
 * Help content for Stage 12 → Orchestrator slot + max_delegations
 * stage.config.
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Orchestrator',
  summary:
    "How the turn is routed when the model emits delegation signals — to a sub-agent, to an evaluator pass, to a typed dispatch. The default (`single_agent`) is a no-op pass-through that keeps the turn linear.",
  whatItDoes: `Stage 12 sits between the LLM call and the loop layer. Most pipelines run \`single_agent\` and Stage 12 does nothing visible. Pipelines that orchestrate multiple agents (delegation, generator/evaluator, typed dispatch) use Stage 12 as the routing layer.

The orchestrator reads:

- \`state.delegate_requests\` — delegation signals from Stage 9 (set when the LLM emits \`<DELEGATE...>\` or signals \`DELEGATE\`)
- \`state.metadata\` — for evaluator / subagent_type to find their input

And writes:

- \`state.agent_results\` — outputs from sub-agents
- \`state.metadata["evaluation_input"]\` — for the evaluator pattern

**\`max_delegations\` is the safety knob.** Each turn can emit multiple delegation signals; this caps how many sub-agent calls the orchestrator will dispatch in one turn. Default 4. Hard cap to prevent recursive blowups.`,
  options: [
    {
      id: 'single_agent',
      label: 'Single agent',
      description: `No delegation. Pass-through orchestrator that doesn't dispatch any sub-agents. Default for normal chat / tool-using pipelines that don't fan out.

The right choice for ~95% of pipelines.`,
      bestFor: [
        'Default for new pipelines — most agents don\'t need delegation',
        'Linear chat / tool-call workflows',
        'Pipelines where delegation is handled at a higher level (host orchestrator, not Stage 12)',
      ],
      avoidWhen: [
        'You actually want sub-agent dispatch — pick `delegate` or `subagent_type` instead',
      ],
      codeRef:
        'geny-executor / s12_agent/artifact/default/orchestrators.py:SingleAgentOrchestrator',
    },
    {
      id: 'delegate',
      label: 'Delegate',
      description: `When \`state.delegate_requests\` is non-empty (Stage 9 saw \`DELEGATE\` signals), dispatch each request as a sub-agent invocation. Sub-agent results land in \`state.agent_results\`.

The dispatched sub-agent is built from the same pipeline configuration but with its own state — the parent agent gets results back as structured outputs.`,
      bestFor: [
        'Plan-and-execute agents — main agent decides what to delegate, sub-agent does the work',
        'Tool-heavy agents that want isolated sub-pipelines for specific complex tools',
        'Agents that mix free-form reasoning with structured fan-out',
      ],
      avoidWhen: [
        'You don\'t emit `DELEGATE` signals — the orchestrator just runs `single_agent`-equivalent logic',
        'Recursive delegation that could blow up — also set `max_delegations` low',
      ],
      gotchas: [
        '`max_delegations` caps PER TURN. Sub-agents themselves can re-delegate, so the total tree depth depends on whether sub-agents have their own Stage 12 with delegation enabled.',
      ],
      codeRef:
        'geny-executor / s12_agent/artifact/default/orchestrators.py:DelegateOrchestrator',
    },
    {
      id: 'evaluator',
      label: 'Evaluator',
      description: `Generator/evaluator pattern. The first pass runs the main agent to produce a candidate output; the second pass runs an evaluator agent to score / accept / reject the candidate.

\`state.metadata["evaluation_input"]\` is what the orchestrator hands to the evaluator. The result lands in \`state.agent_results\` as the evaluator's verdict.

Two-pass turns roughly double the cost — only worth it when output quality varies enough that an evaluator can meaningfully filter.`,
      bestFor: [
        'Quality-critical workflows (legal drafts, code generation, anything where a wrong answer is expensive)',
        'A/B model comparisons — generator on cheap model, evaluator on capable model',
        'Self-consistency setups — generator produces 5 candidates, evaluator picks one',
      ],
      avoidWhen: [
        'Cost-sensitive workloads — two-pass roughly doubles per-turn cost',
        'Low-stakes chat — evaluator overhead doesn\'t pay off',
      ],
      codeRef:
        'geny-executor / s12_agent/artifact/default/orchestrators.py:EvaluatorOrchestrator',
    },
    {
      id: 'subagent_type',
      label: 'Subagent type',
      description: `Typed dispatch via \`SubagentTypeRegistry\`. The model's output indicates a typed subagent (by name); the orchestrator looks up the registered subagent class and dispatches.

Useful when you want a fixed set of specialised subagents (e.g., \`codeReviewer\`, \`docWriter\`, \`testGenerator\`) and the parent agent picks which to delegate to by emitting the type name.`,
      bestFor: [
        'Pipelines with a fixed subagent vocabulary — typed dispatch is more constrained than free-form `delegate`',
        'Multi-tenant systems where each subagent has different permissions / tool access',
      ],
      avoidWhen: [
        'You don\'t have a `SubagentTypeRegistry` configured — the orchestrator has nothing to dispatch to',
      ],
      gotchas: [
        '**Requires `SubagentTypeRegistry` populated by the host.** The manifest can name `subagent_type` as the orchestrator but cannot install registered subagents — that\'s host-side wiring.',
      ],
      codeRef:
        'geny-executor / s12_agent/artifact/default/orchestrators.py:SubagentTypeOrchestrator',
    },
  ],
  configFields: [
    {
      name: 'config.max_delegations',
      label: 'Max delegations per turn',
      type: 'integer',
      default: '4',
      description:
        'Hard cap on how many sub-agent calls the orchestrator will dispatch in one turn. Default 4. Recursive delegation through child Stage 12 instances is NOT counted here — set the same cap on child stages too if you want a global cap.',
    },
  ],
  relatedSections: [
    {
      label: 'Stage 9 — DELEGATE signal',
      body: '`delegate` orchestrator depends on Stage 9\'s signal detector setting `state.delegate_requests`. Without that, no delegation happens regardless of orchestrator pick.',
    },
    {
      label: 'Stage 14 — Evaluate (evaluator strategy)',
      body: 'Stage 14 also runs evaluator-pattern logic but at a different point in the pipeline (after the loop, not within a turn). They\'re complementary — Stage 12 does intra-turn evaluation, Stage 14 does post-turn evaluation.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s12_agent/artifact/default/orchestrators.py',
};

const ko: SectionHelpContent = {
  title: '오케스트레이터 (Orchestrator)',
  summary:
    '모델이 위임 신호를 emit 할 때 턴이 어떻게 라우팅될지 — 서브 에이전트, evaluator pass, typed dispatch 로. 기본값 (\`single_agent\`) 은 턴을 선형으로 유지하는 no-op pass-through.',
  whatItDoes: `12단계는 LLM 호출과 루프 레이어 사이에 위치. 대부분의 파이프라인은 \`single_agent\` 를 실행하고 12단계는 보이지 않게 아무것도 안 함. 멀티 에이전트 (위임, generator/evaluator, typed dispatch) 를 오케스트레이션하는 파이프라인이 12단계를 라우팅 레이어로 사용.

오케스트레이터가 읽음:

- \`state.delegate_requests\` — 9단계의 위임 신호 (LLM 이 \`<DELEGATE...>\` emit 또는 \`DELEGATE\` 신호 시 설정)
- \`state.metadata\` — evaluator / subagent_type 가 입력 찾는 곳

씀:

- \`state.agent_results\` — 서브 에이전트의 출력
- \`state.metadata["evaluation_input"]\` — evaluator 패턴용

**\`max_delegations\` 가 안전 knob.** 각 턴이 여러 위임 신호 emit 가능; 이것이 한 턴에 오케스트레이터가 dispatch 할 서브 에이전트 호출 수를 cap. 기본값 4. 재귀 폭발 방지를 위한 hard cap.`,
  options: [
    {
      id: 'single_agent',
      label: '단일 에이전트',
      description: `위임 없음. 서브 에이전트를 dispatch 안 하는 pass-through 오케스트레이터. fan out 안 하는 일반 채팅 / 도구 사용 파이프라인의 기본값.

파이프라인의 ~95% 에 옳은 선택.`,
      bestFor: [
        '새 파이프라인의 기본값 — 대부분의 에이전트는 위임 불필요',
        '선형 채팅 / 도구 호출 워크플로',
        '위임이 더 높은 레벨 (호스트 오케스트레이터, 12단계 아님) 에서 처리되는 파이프라인',
      ],
      avoidWhen: [
        '실제로 서브 에이전트 dispatch 를 원할 때 — `delegate` 또는 `subagent_type` 선택',
      ],
      codeRef:
        'geny-executor / s12_agent/artifact/default/orchestrators.py:SingleAgentOrchestrator',
    },
    {
      id: 'delegate',
      label: '위임 (Delegate)',
      description: `\`state.delegate_requests\` 가 비어있지 않을 때 (9단계가 \`DELEGATE\` 신호 봤음), 각 요청을 서브 에이전트 호출로 dispatch. 서브 에이전트 결과가 \`state.agent_results\` 에 land.

dispatch 된 서브 에이전트는 같은 파이프라인 구성으로 빌드되지만 자체 state — 부모 에이전트가 결과를 구조화 출력으로 받음.`,
      bestFor: [
        '계획 후 실행 에이전트 — 메인 에이전트가 위임할 것 결정, 서브 에이전트가 작업 수행',
        '특정 복잡 도구를 위해 격리된 서브 파이프라인을 원하는 도구 무거운 에이전트',
        '자유 형식 reasoning 과 구조화 fan-out 을 섞는 에이전트',
      ],
      avoidWhen: [
        '`DELEGATE` 신호를 emit 하지 않을 때 — 오케스트레이터가 단지 `single_agent` 동등 로직 실행',
        '폭발할 수 있는 재귀 위임 — `max_delegations` 도 낮게 설정',
      ],
      gotchas: [
        '`max_delegations` 는 턴당 cap. 서브 에이전트가 자체 재위임 가능, 따라서 총 트리 깊이는 서브 에이전트가 위임 활성화된 자체 12단계를 가지는지에 따라 달림.',
      ],
      codeRef:
        'geny-executor / s12_agent/artifact/default/orchestrators.py:DelegateOrchestrator',
    },
    {
      id: 'evaluator',
      label: '평가자 (Evaluator)',
      description: `Generator/evaluator 패턴. 첫 pass 가 메인 에이전트를 실행해 candidate 출력 생산; 두 번째 pass 가 evaluator 에이전트를 실행해 candidate 점수 / 수락 / 거부.

\`state.metadata["evaluation_input"]\` 이 오케스트레이터가 evaluator 에 넘기는 것. 결과가 evaluator 의 verdict 으로 \`state.agent_results\` 에 land.

2-pass 턴은 비용을 대략 두 배로 만듦 — 출력 품질이 evaluator 가 의미 있게 필터링할 만큼 변할 때만 가치 있음.`,
      bestFor: [
        '품질 critical 워크플로 (법률 초안, 코드 생성, 잘못된 답이 비싼 모든 것)',
        'A/B 모델 비교 — 싼 모델의 generator, 능력 있는 모델의 evaluator',
        '자기 일관성 설정 — generator 가 5 candidate 생산, evaluator 가 하나 선택',
      ],
      avoidWhen: [
        '비용 민감 워크로드 — 2-pass 가 턴당 비용을 대략 2배로',
        '낮은 stake 채팅 — evaluator 오버헤드가 가치 없음',
      ],
      codeRef:
        'geny-executor / s12_agent/artifact/default/orchestrators.py:EvaluatorOrchestrator',
    },
    {
      id: 'subagent_type',
      label: '서브 에이전트 타입',
      description: `\`SubagentTypeRegistry\` 통한 typed dispatch. 모델 출력이 typed 서브 에이전트 (이름으로) 표시; 오케스트레이터가 등록된 서브 에이전트 클래스 lookup 후 dispatch.

고정 specialised 서브 에이전트 집합 (예: \`codeReviewer\`, \`docWriter\`, \`testGenerator\`) 을 원하고 부모 에이전트가 타입 이름을 emit 해 어느 것에 위임할지 선택할 때 유용.`,
      bestFor: [
        '고정 서브 에이전트 vocabulary 의 파이프라인 — typed dispatch 가 자유 형식 `delegate` 보다 더 제약',
        '각 서브 에이전트가 다른 권한 / 도구 접근을 가지는 멀티 테넌트 시스템',
      ],
      avoidWhen: [
        '`SubagentTypeRegistry` 가 구성 안 됐을 때 — 오케스트레이터가 dispatch 할 게 없음',
      ],
      gotchas: [
        '**호스트가 채운 `SubagentTypeRegistry` 필요.** 매니페스트가 `subagent_type` 을 오케스트레이터로 명명할 수 있지만 등록된 서브 에이전트는 설치 못 함 — 그것은 호스트 측 wiring.',
      ],
      codeRef:
        'geny-executor / s12_agent/artifact/default/orchestrators.py:SubagentTypeOrchestrator',
    },
  ],
  configFields: [
    {
      name: 'config.max_delegations',
      label: '턴당 최대 위임 수',
      type: 'integer',
      default: '4',
      description:
        '한 턴에 오케스트레이터가 dispatch 할 서브 에이전트 호출 수의 hard cap. 기본값 4. 자식 12단계 인스턴스를 통한 재귀 위임은 여기 카운트 안 됨 — 글로벌 cap 을 원하면 자식 stage 에도 같은 cap 설정.',
    },
  ],
  relatedSections: [
    {
      label: '9단계 — DELEGATE 신호',
      body: '`delegate` 오케스트레이터는 9단계의 신호 감지기가 `state.delegate_requests` 설정에 의존. 그것 없이 오케스트레이터 선택과 무관하게 위임 일어나지 않음.',
    },
    {
      label: '14단계 — Evaluate (evaluator 전략)',
      body: '14단계도 evaluator 패턴 로직 실행하지만 파이프라인의 다른 지점 (루프 후, 턴 내가 아님). 보완적 — 12단계가 턴 내 evaluation, 14단계가 턴 후 evaluation.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s12_agent/artifact/default/orchestrators.py',
};

export const stage12OrchestratorHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
