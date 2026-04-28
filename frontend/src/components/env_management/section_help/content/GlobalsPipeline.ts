/**
 * Help content for Globals → 스테이지 기본 설정 panel.
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Stage defaults (Pipeline config)',
  summary:
    'Top-level `manifest.pipeline` (a.k.a. `PipelineConfig`) — limits, behaviour toggles, and stage-level routing decisions that apply to every turn of the agent loop.',
  whatItDoes: `These values are projected onto \`PipelineState\` at session start and read by Stage 5 (Cache), Stage 7 (Token), Stage 16 (Loop), and Stage 19 (Summarize) for budget enforcement and termination decisions.

**Limits** (\`max_iterations\`, \`cost_budget_usd\`, \`context_window_budget\`) are checked at multiple choke points:

- Stage 16's loop controller halts when \`state.turn_count >= max_iterations\`.
- Stage 7's cost tracker accumulates per-call cost from the unified pricing table; when \`state.cumulative_cost_usd >= cost_budget_usd\`, the next turn is blocked. Models not in \`ALL_PRICING\` count as 0 cost.
- Stage 5's cache strategies and Stage 19's summarizer use \`context_window_budget\` as the trigger for compaction / summarization passes.

**Behaviour toggles**:

- \`stream=true\`: SSE event stream during execution. Required for any UI that wants live token output. Set to \`false\` for batch jobs / evals where you want the final response only.
- \`single_turn=true\`: skips the agent loop entirely — one LLM call, no Stage 16. Useful for RAG generation steps, classification jobs, or any "respond once and stop" pipeline. Disables tool calls in practice (tool dispatch happens in Stage 10 which feeds back into Stage 16).

**Routing**:

- \`base_url\` overrides the inference endpoint. For Anthropic, leave blank to use \`api.anthropic.com\`. For vLLM, **must** be set (e.g., \`http://localhost:8000/v1\`). For forwarders / proxies (Helicone, OpenRouter Anthropic mode), set the proxy URL here.
- \`artifacts\` selects an alternative implementation per stage. The provider segment control in the Model panel sets \`artifacts.s06_api\` automatically; use this field directly to override other stages, e.g. \`{"s18_memory": "vector"}\` to swap in a vector-store memory artifact.
- \`metadata\` is an opaque dict — the executor core never reads it. Geny backend uses it for routing / logging / A/B branches. Free-form JSON object.

**\`name\`** is mostly cosmetic for single-pipeline environments; it appears in logs and in metrics keys. For multi-pipeline deployments it's the actual identifier.`,
  configFields: [
    {
      name: 'name',
      label: 'Pipeline name',
      type: 'string',
      default: 'default',
      description:
        'Identifier used in logs / metrics keys. Mostly cosmetic for single-pipeline environments.',
    },
    {
      name: 'base_url',
      label: 'Base URL',
      type: 'string',
      description:
        'Inference endpoint override. Required for vLLM. Leave blank to use the provider\'s official URL. Useful for proxies / forwarders / local mocks.',
    },
    {
      name: 'max_iterations',
      label: 'Max iterations',
      type: 'integer ≥ 1',
      default: '50',
      description:
        'Hard cap on agent loop turns. Stage 16 halts when reached. Bump up for tool-heavy work; bump down for short-form responses.',
    },
    {
      name: 'context_window_budget',
      label: 'Context window budget (tokens)',
      type: 'integer ≥ 1024',
      default: '200000',
      description:
        'Trigger threshold for cache compaction (Stage 5) and summarization (Stage 19). Match this to your model\'s real context limit (Sonnet 4.6 ≈ 200K, GPT-4o = 128K, etc.).',
    },
    {
      name: 'cost_budget_usd',
      label: 'Cost budget (USD)',
      type: 'float ≥ 0',
      description:
        'Cumulative cost ceiling. Stage 7 blocks the next turn when reached. Leave blank for unbounded.',
    },
    {
      name: 'stream',
      label: 'Stream',
      type: 'boolean',
      default: 'true',
      description:
        'Emit SSE events during execution. Off for batch / eval pipelines.',
    },
    {
      name: 'single_turn',
      label: 'Single turn',
      type: 'boolean',
      default: 'false',
      description:
        'Skip the agent loop — one LLM call and stop. Disables Stage 16 / 10. For RAG generation, classifiers, etc.',
    },
    {
      name: 'artifacts',
      label: 'Artifact overrides',
      type: 'dict[str, str]',
      description:
        'Maps stage id → artifact name. Lets you swap a stage\'s implementation without rewriting the manifest. Empty stages use "default".',
    },
    {
      name: 'metadata',
      label: 'Free-form metadata',
      type: 'dict',
      description:
        'Opaque to the executor — Geny backend uses it for routing / logging / experiments.',
    },
  ],
  options: [],
  relatedSections: [
    {
      label: 'Stage 5 — Cache',
      body: 'Cache compaction strategies use context_window_budget to decide when to compact.',
    },
    {
      label: 'Stage 7 — Token',
      body: 'Cost tracker enforces cost_budget_usd; calculator uses the unified pricing table.',
    },
    {
      label: 'Stage 16 — Loop',
      body: 'Loop controller honours max_iterations as a hard stop.',
    },
    {
      label: 'Stage 19 — Summarize',
      body: 'Summarization triggers when cumulative tokens approach context_window_budget.',
    },
  ],
  codeRef: 'geny-executor / src/geny_executor/core/config.py:PipelineConfig',
};

const ko: SectionHelpContent = {
  title: '스테이지 기본 설정 (Pipeline config)',
  summary:
    '최상위 `manifest.pipeline` (a.k.a. `PipelineConfig`) — 에이전트 루프의 매 턴에 적용되는 한도 / 동작 토글 / 단계 레벨 라우팅.',
  whatItDoes: `이 값들은 세션 시작 시 \`PipelineState\`에 투영되어 5단계 (Cache), 7단계 (Token), 16단계 (Loop), 19단계 (Summarize)에서 예산 강제와 종료 결정에 사용됩니다.

**한도** (\`max_iterations\`, \`cost_budget_usd\`, \`context_window_budget\`)는 여러 choke point에서 검사:

- 16단계 루프 컨트롤러는 \`state.turn_count >= max_iterations\`이면 중단.
- 7단계 cost tracker가 통합 pricing 테이블에서 호출별 비용을 누적; \`state.cumulative_cost_usd >= cost_budget_usd\`이면 다음 턴 차단. \`ALL_PRICING\`에 없는 모델은 비용 0으로 카운트.
- 5단계 cache 전략과 19단계 summarizer가 \`context_window_budget\`을 compaction / summarization 트리거로 사용.

**동작 토글**:

- \`stream=true\`: 실행 중 SSE 이벤트 스트리밍. 실시간 토큰 출력이 필요한 UI는 필수. 배치 / 평가 작업처럼 최종 응답만 필요하면 \`false\`.
- \`single_turn=true\`: 에이전트 루프 자체를 건너뜀 — LLM 호출 1회 후 종료, 16단계 우회. RAG 생성 단계, 분류 작업, "한 번 응답하고 끝" 파이프라인에 유용. 도구 호출은 사실상 비활성 (도구 dispatch는 16단계로 피드백되는 10단계에서 일어나므로).

**라우팅**:

- \`base_url\`은 추론 엔드포인트 override. Anthropic은 비워두면 \`api.anthropic.com\`. vLLM은 **필수** (예: \`http://localhost:8000/v1\`). 포워더 / 프록시 (Helicone, OpenRouter Anthropic 모드)는 프록시 URL을 여기에.
- \`artifacts\`는 단계별 대체 구현 선택. 모델 패널의 provider 세그먼트 컨트롤이 자동으로 \`artifacts.s06_api\`를 설정; 다른 단계 (예: \`{"s18_memory": "vector"}\`)는 여기서 직접.
- \`metadata\`는 opaque dict — 실행기 코어는 안 건드림. Geny 백엔드가 라우팅 / 로깅 / A/B 분기에 사용. 자유 형식 JSON 객체.

**\`name\`**은 단일 파이프라인 환경에선 거의 cosmetic; 로그와 메트릭 키에 사용. 멀티 파이프라인 배포에선 실제 식별자.`,
  configFields: [
    {
      name: 'name',
      label: '파이프라인 이름',
      type: 'string',
      default: 'default',
      description:
        '로그 / 메트릭 키에 쓰이는 식별자. 단일 파이프라인 환경에선 거의 cosmetic.',
    },
    {
      name: 'base_url',
      label: 'Base URL',
      type: 'string',
      description:
        '추론 엔드포인트 override. vLLM은 필수. 비우면 프로바이더 공식 URL. 프록시 / 포워더 / 로컬 모킹에 사용.',
    },
    {
      name: 'max_iterations',
      label: '최대 반복',
      type: 'integer ≥ 1',
      default: '50',
      description:
        '에이전트 루프 턴의 hard cap. 16단계가 이 값 도달 시 중단. 도구 콜이 많은 작업은 늘리고, 짧은 응답은 줄이세요.',
    },
    {
      name: 'context_window_budget',
      label: '컨텍스트 창 예산 (토큰)',
      type: 'integer ≥ 1024',
      default: '200000',
      description:
        '캐시 compaction (5단계)과 summarization (19단계)의 트리거 임계값. 모델의 실제 컨텍스트 한도에 맞추세요 (Sonnet 4.6 ≈ 200K, GPT-4o = 128K 등).',
    },
    {
      name: 'cost_budget_usd',
      label: '비용 예산 (USD)',
      type: 'float ≥ 0',
      description:
        '누적 비용 상한. 7단계가 도달 시 다음 턴 차단. 비우면 무제한.',
    },
    {
      name: 'stream',
      label: '스트림',
      type: 'boolean',
      default: 'true',
      description:
        '실행 중 SSE 이벤트 emit. 배치 / 평가 파이프라인은 끄세요.',
    },
    {
      name: 'single_turn',
      label: '싱글 턴',
      type: 'boolean',
      default: 'false',
      description:
        '에이전트 루프 건너뜀 — LLM 호출 1회 후 종료. 16단계 / 10단계 비활성. RAG 생성, 분류기 등에 사용.',
    },
    {
      name: 'artifacts',
      label: '아티팩트 override',
      type: 'dict[str, str]',
      description:
        '단계 id → 아티팩트 이름 매핑. 매니페스트 재작성 없이 단계 구현을 교체. 미지정 단계는 "default" 사용.',
    },
    {
      name: 'metadata',
      label: '자유 형식 메타데이터',
      type: 'dict',
      description:
        '실행기에겐 opaque — Geny 백엔드가 라우팅 / 로깅 / 실험에 사용.',
    },
  ],
  options: [],
  relatedSections: [
    {
      label: '5단계 — Cache',
      body: 'Cache compaction 전략이 context_window_budget으로 compaction 시점 결정.',
    },
    {
      label: '7단계 — Token',
      body: 'Cost tracker가 cost_budget_usd 강제; calculator는 통합 pricing 테이블 사용.',
    },
    {
      label: '16단계 — Loop',
      body: 'Loop controller가 max_iterations를 hard stop으로 사용.',
    },
    {
      label: '19단계 — Summarize',
      body: '누적 토큰이 context_window_budget에 가까워지면 summarization 발동.',
    },
  ],
  codeRef: 'geny-executor / src/geny_executor/core/config.py:PipelineConfig',
};

export const globalsPipelineHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
