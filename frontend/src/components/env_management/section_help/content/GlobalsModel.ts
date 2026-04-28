/**
 * Help content for Globals → 기본 모델 설정 panel.
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Default model config',
  summary:
    'Top-level `manifest.model` (a.k.a. `ModelConfig`) — sampling parameters and extended-thinking knobs that apply to every LLM call unless a stage explicitly overrides them via `model_override`.',
  whatItDoes: `These values are projected onto \`PipelineState\` at session start (\`PipelineConfig.apply_to_state\`) and read by Stage 6 (API) when assembling the request to the provider, and by Stage 8 (Think) for extended-thinking budget sizing.

The **provider** segmented control writes \`manifest.stages[s06_api].config.provider\`. The default API stage's \`update_config\` consumes that on session boot to pick the right adapter from \`ClientRegistry\` (\`anthropic\` / \`openai\` / \`google\` / \`vllm\`). When unset, the executor falls back to prefix-inference on the model id (\`gpt-\` / \`o3\` → openai; \`gemini-\` → google; otherwise anthropic).

The **model** field is free-form on the wire — what gets sent verbatim is what the provider sees. The dropdown is a curated catalog mirroring the executor's \`stages/s07_token/.../pricing.py::ALL_PRICING\` table; any model not in that table won't be billed (cost = 0) but otherwise works fine. vLLM is intentionally free-text because the served model is whatever your endpoint advertises.

**Sampling parameters** map 1:1 to the Anthropic Messages API surface; OpenAI / Google adapters translate them as needed. Use either \`temperature\` OR \`top_p\` — combining the two breaks Anthropic's API contract. \`top_k\` is a power-user knob that most callers should leave unset.

**Extended thinking** lights up Claude's reasoning mode. \`thinking_enabled=true\` requires \`thinking_budget_tokens < max_tokens\`. \`thinking_type="adaptive"\` is the recommended setting on Sonnet 4.6+ — the model sizes its own budget per turn instead of using a static cap.

**api_key** is intentionally not editable here. Deploy-time secrets come from environment variables (\`ANTHROPIC_API_KEY\`, \`OPENAI_API_KEY\`, etc.) — putting them in the manifest would leak them into git history and exports.`,
  configFields: [
    {
      name: 'model',
      label: 'Model identifier',
      type: 'string',
      default: 'claude-sonnet-4-6',
      required: true,
      description:
        'Exact identifier sent to the inference API. Catalog provides the current Anthropic / OpenAI / Google line-ups; vLLM is free-text.',
    },
    {
      name: 'max_tokens',
      label: 'Max output tokens',
      type: 'integer',
      default: '8192',
      description:
        'Hard cap on the response length. Counts only output, not the prompt. Must be > thinking_budget_tokens when thinking is enabled.',
    },
    {
      name: 'temperature',
      label: 'Sampling temperature',
      type: 'float (0.0 – 2.0)',
      default: '0.0',
      description:
        '0.0 = deterministic argmax; higher = more diverse. Mutually exclusive with top_p.',
    },
    {
      name: 'top_p',
      label: 'Nucleus sampling',
      type: 'float (0.0 – 1.0)',
      description:
        'Sample from the smallest token set whose probability mass exceeds top_p. Leave unset unless you know why you want it.',
    },
    {
      name: 'top_k',
      label: 'Top-k sampling',
      type: 'integer ≥ 1',
      description:
        'Restrict sampling to the top-k most likely tokens. Advanced — most callers leave this empty.',
    },
    {
      name: 'stop_sequences',
      label: 'Stop sequences',
      type: 'list[string]',
      description:
        'Hard-stop strings — generation halts the moment any sequence appears in the output stream. Useful for templated formats with known closers.',
    },
    {
      name: 'thinking_enabled',
      label: 'Enable extended thinking',
      type: 'boolean',
      default: 'false',
      description:
        "Turn on Claude's reasoning trace. Adds a <thinking> phase before the answer; charges thinking_budget_tokens against the output budget.",
    },
    {
      name: 'thinking_budget_tokens',
      label: 'Thinking token budget',
      type: 'integer ≥ 1',
      default: '10000',
      description:
        'Maximum tokens the model may spend on reasoning before producing the answer. Must be < max_tokens.',
    },
    {
      name: 'thinking_type',
      label: 'Thinking dispatch type',
      type: 'enum',
      default: 'enabled',
      description:
        'enabled: always think with the full budget. adaptive (recommended for 4.6+): model sizes its own budget per turn. disabled: pre-set the field but skip the reasoning phase this run.',
    },
    {
      name: 'thinking_display',
      label: 'Thinking visibility',
      type: 'enum',
      description:
        "summarized: emit a condensed thinking trace alongside the answer. omitted: hide thinking from the response (still billed). Defaults to provider's choice.",
    },
  ],
  options: [],
  relatedSections: [
    {
      label: 'Stage 6 — API',
      body: 'The default APIStage is what actually sends the request. Its provider config field reads the value the provider segmented control writes here.',
    },
    {
      label: 'Stage 8 — Think',
      body: 'When thinking is enabled, Stage 8 sizes thinking_budget_tokens via its budget planner — adaptive planners use the manifest budget as the upper bound.',
    },
    {
      label: 'Per-stage model overrides',
      body: 'Any stage with a model_override card (Stage 6, Stage 18 memory, etc.) replaces just the fields it sets. Unset fields fall back to these defaults.',
    },
  ],
  codeRef: 'geny-executor / src/geny_executor/core/config.py:ModelConfig',
};

const ko: SectionHelpContent = {
  title: '기본 모델 설정',
  summary:
    '최상위 `manifest.model` (a.k.a. `ModelConfig`) — 단계가 `model_override`로 명시적으로 덮어쓰지 않는 한 모든 LLM 호출에 적용되는 샘플링 파라미터와 확장 사고 옵션.',
  whatItDoes: `이 값들은 세션 시작 시점에 \`PipelineConfig.apply_to_state\`로 \`PipelineState\`에 투영되어, 6단계 (API)에서 프로바이더로 보내는 요청을 조립할 때, 그리고 8단계 (Think)에서 확장 사고 예산을 산정할 때 읽힙니다.

**프로바이더** 세그먼트 컨트롤은 \`manifest.stages[s06_api].config.provider\`에 기록합니다. default API 스테이지의 \`update_config\`이 이 값을 세션 부팅 시 소비해 \`ClientRegistry\`에서 적절한 어댑터를 선택 (\`anthropic\` / \`openai\` / \`google\` / \`vllm\`). 값이 비어 있으면 실행기는 모델 id의 prefix로 추론 (\`gpt-\` / \`o3\` → openai, \`gemini-\` → google, 그 외 → anthropic).

**모델** 필드는 wire 레벨에선 free-form — 입력한 값이 그대로 프로바이더로 전달됩니다. 드랍다운은 실행기의 \`stages/s07_token/.../pricing.py::ALL_PRICING\` 테이블을 미러한 큐레이션 카탈로그. 카탈로그에 없는 모델도 동작은 하지만 비용이 0으로 계산됩니다. vLLM은 엔드포인트가 광고하는 모델 명을 그대로 입력해야 해서 의도적으로 free-text.

**샘플링 파라미터**는 Anthropic Messages API와 1:1 매핑; OpenAI / Google 어댑터가 필요시 변환합니다. \`temperature\` 또는 \`top_p\` 둘 중 하나만 쓰세요 — 동시 사용은 Anthropic API 규약 위반. \`top_k\`는 고급 옵션으로 대부분의 호출자는 비워둡니다.

**확장 사고**는 Claude의 추론 모드를 켭니다. \`thinking_enabled=true\`일 때 반드시 \`thinking_budget_tokens < max_tokens\`. \`thinking_type="adaptive"\`는 Sonnet 4.6+에서 권장 — 모델이 매 턴마다 스스로 예산을 산정하므로 정적 캡보다 효율적.

**api_key**는 의도적으로 편집 불가. 배포 시점의 비밀은 환경 변수 (\`ANTHROPIC_API_KEY\` 등)에서 주입 — 매니페스트에 박아 넣으면 git 이력과 export에 유출됩니다.`,
  configFields: [
    {
      name: 'model',
      label: '모델 식별자',
      type: 'string',
      default: 'claude-sonnet-4-6',
      required: true,
      description:
        '추론 API에 그대로 전달되는 식별자. 카탈로그는 현재 Anthropic / OpenAI / Google 라인업을 제공; vLLM은 자유 입력.',
    },
    {
      name: 'max_tokens',
      label: '최대 출력 토큰',
      type: 'integer',
      default: '8192',
      description:
        '응답 길이의 hard cap. 출력만 카운트, 프롬프트 토큰은 별개. thinking 활성화 시 thinking_budget_tokens보다 커야 함.',
    },
    {
      name: 'temperature',
      label: '샘플링 온도',
      type: 'float (0.0 – 2.0)',
      default: '0.0',
      description:
        '0.0 = deterministic argmax; 높을수록 다양성 ↑. top_p와 상호 배타.',
    },
    {
      name: 'top_p',
      label: 'Nucleus 샘플링',
      type: 'float (0.0 – 1.0)',
      description:
        '확률 질량이 top_p를 초과하는 가장 작은 토큰 집합에서 샘플링. 명확한 이유가 없다면 비워두세요.',
    },
    {
      name: 'top_k',
      label: 'Top-k 샘플링',
      type: 'integer ≥ 1',
      description:
        '확률 상위 k개 토큰으로 샘플링 제한. 고급 옵션 — 대부분 비워둠.',
    },
    {
      name: 'stop_sequences',
      label: '중지 시퀀스',
      type: 'list[string]',
      description:
        '하드 스톱 문자열 — 출력 스트림에 등장하는 즉시 생성 중단. 알려진 종결자가 있는 템플릿 포맷에 유용.',
    },
    {
      name: 'thinking_enabled',
      label: '확장 사고 활성화',
      type: 'boolean',
      default: 'false',
      description:
        'Claude의 추론 트레이스 켜기. 답변 전에 <thinking> 단계를 거치며, thinking_budget_tokens는 출력 예산에 청구됨.',
    },
    {
      name: 'thinking_budget_tokens',
      label: '사고 토큰 예산',
      type: 'integer ≥ 1',
      default: '10000',
      description:
        '답변 생성 전 모델이 추론에 사용 가능한 최대 토큰 수. max_tokens보다 작아야 함.',
    },
    {
      name: 'thinking_type',
      label: '사고 디스패치 타입',
      type: 'enum',
      default: 'enabled',
      description:
        'enabled: 항상 전체 예산으로 사고. adaptive (4.6+ 권장): 모델이 매 턴 예산을 자체 산정. disabled: 필드는 사전 설정해두되 이번 실행은 추론 단계 건너뜀.',
    },
    {
      name: 'thinking_display',
      label: '사고 표시 방식',
      type: 'enum',
      description:
        'summarized: 요약된 사고 트레이스를 답변 옆에 emit. omitted: 응답에서 사고를 숨김 (요금은 그대로). 미설정 시 프로바이더 기본값.',
    },
  ],
  options: [],
  relatedSections: [
    {
      label: '6단계 — API',
      body: '실제 요청을 보내는 곳. provider 세그먼트 컨트롤이 기록한 값을 default APIStage의 provider config 필드가 읽습니다.',
    },
    {
      label: '8단계 — Think',
      body: 'thinking이 활성화된 경우 8단계의 budget planner가 thinking_budget_tokens를 산정 — adaptive 플래너는 매니페스트 예산을 상한으로 사용.',
    },
    {
      label: '단계별 모델 오버라이드',
      body: 'model_override 카드가 있는 단계 (6단계 / 18단계 메모리 등)는 설정한 필드만 교체합니다. 미설정 필드는 이 기본값으로 fallback.',
    },
  ],
  codeRef: 'geny-executor / src/geny_executor/core/config.py:ModelConfig',
};

export const globalsModelHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
