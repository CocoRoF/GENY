/**
 * Help content for Stage 6 → Model override section.
 *
 * Source of truth: geny-executor /
 *   src/geny_executor/core/stage.py:Stage.resolve_model_config
 *   src/geny_executor/stages/s06_api/artifact/default/stage.py:APIStage.execute
 *   StageModelOverride type in core/environment.py
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Model override',
  summary:
    "Lets this stage call the LLM with a **different model / system prompt / max_tokens / temperature / top_p** than the pipeline-level defaults. When off, Stage 6 uses the pipeline's `state.model` and friends.",
  whatItDoes: `Stage 6 (API) is the LLM call. By default it reads \`state.model\` (set at pipeline construction or via the global Model panel above the stage list) and ships the request to that model.

When **Model override** is on, Stage 6 reads \`entry.model_override\` from the manifest and merges those fields over the pipeline defaults *for this stage only*. The next call goes out with the merged config; nothing else in the pipeline sees the override.

**Where the override actually applies:** \`Stage.resolve_model_config(state)\` is what the stage calls on every \`execute()\`. It builds the effective \`ModelConfig\` by:

1. starting from the pipeline default
2. layering \`entry.model_override\` (the manifest field) over it
3. layering \`state.metadata["llm_overrides"]\` (turn-level dynamic overrides) on top

So the manifest override is *durable* across turns; runtime overrides via \`state.metadata\` win the conflict but are usually one-shot.

**What can be overridden:**

- \`model\` — switch the model entirely (\`claude-haiku-4-5\` for cheap retries, \`claude-opus-4-7\` for hard turns)
- \`system_prompt\` — override the system prompt for this stage. **Almost never useful here** — Stage 3 owns system prompts. Use sparingly and document why.
- \`max_tokens\` — cap output for this stage
- \`temperature\` / \`top_p\` — sampling controls

**Other stages that also support model override:** Stage 2 (Context) for its LLM-summary compactor, Stage 14 (Evaluate) for evaluator strategy, Stage 18 (Memory) for reflective summarisers. The override mechanism is the same — \`entry.model_override\` is a stage-level field on every Stage that supports it.`,
  configFields: [
    {
      name: 'model_override.model',
      label: 'Model',
      type: 'string',
      description:
        'Vendor + model id, e.g. `claude-opus-4-7-20260101` or `gpt-5-1106`. Empty / unset = inherit pipeline default.',
    },
    {
      name: 'model_override.system_prompt',
      label: 'System prompt',
      type: 'string',
      description:
        'Per-stage system prompt. Almost always wrong to set here — Stage 3 owns system prompts. The exception is when this stage genuinely needs different persona / instructions than the rest of the pipeline (rare).',
    },
    {
      name: 'model_override.max_tokens',
      label: 'Max tokens',
      type: 'integer',
      description:
        'Output cap for this stage. Useful for stages that should produce short summaries (e.g., a Stage 14 evaluator returning yes/no).',
    },
    {
      name: 'model_override.temperature',
      label: 'Temperature',
      type: 'number',
      description:
        '0 = deterministic, 1 = creative. For a Stage 6 main-call setup, low (0–0.3) for reasoning / structured output, mid (0.5–0.8) for chat.',
    },
    {
      name: 'model_override.top_p',
      label: 'Top-p',
      type: 'number',
      description:
        'Nucleus sampling. Most pipelines pick **either** temperature OR top_p, not both. Set one to its default and tune the other.',
    },
  ],
  options: [],
  relatedSections: [
    {
      label: 'Global model panel (above the stage list)',
      body: 'The pipeline-level default. Most pipelines edit only this — per-stage overrides are for specific tasks where the default is wrong.',
    },
    {
      label: 'Stage 3 — System',
      body: 'System prompt belongs here, not in the model_override. Use Stage 3\'s prompt builder; only use the override\'s `system_prompt` field for true per-stage exceptions (rare).',
    },
    {
      label: 'Advanced — `state.metadata["llm_overrides"]`',
      body: 'Runtime / turn-level overrides win over manifest model_override. Used by adaptive routers (Stage 14 strategy) that pick a model based on this turn\'s state. The manifest override is the *durable* layer; runtime is the *dynamic* layer.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/core/stage.py:Stage.resolve_model_config',
};

const ko: SectionHelpContent = {
  title: '모델 오버라이드 (Model override)',
  summary:
    '이 단계가 파이프라인 레벨 기본값과 **다른 모델 / 시스템 프롬프트 / max_tokens / temperature / top_p** 로 LLM 을 호출하도록 허용. 끄면 6단계는 파이프라인의 \`state.model\` 과 친구들 사용.',
  whatItDoes: `6단계 (API) 가 LLM 호출. 기본적으로 \`state.model\` (파이프라인 생성 시점 또는 stage 리스트 위 글로벌 Model 패널로 설정) 을 읽고 요청을 그 모델로 보냄.

**Model override** 가 켜져 있으면 6단계가 매니페스트에서 \`entry.model_override\` 를 읽고 그 필드들을 *이 단계에만* 파이프라인 기본값 위에 layer. 다음 호출이 merge 된 config 로 나감; 파이프라인의 다른 어떤 것도 override 를 보지 않음.

**override 가 실제로 적용되는 곳:** \`Stage.resolve_model_config(state)\` 가 단계가 매 \`execute()\` 에서 호출하는 것. 효과적인 \`ModelConfig\` 를 빌드:

1. 파이프라인 기본값에서 시작
2. \`entry.model_override\` (매니페스트 필드) 를 그 위에 layer
3. \`state.metadata["llm_overrides"]\` (턴 레벨 동적 override) 를 맨 위에 layer

따라서 매니페스트 override 는 턴 간 *durable*; \`state.metadata\` 의 런타임 override 가 충돌에서 이김 (보통 일회성).

**override 가능한 것:**

- \`model\` — 모델 통째로 전환 (싼 retry 에 \`claude-haiku-4-5\`, 어려운 턴에 \`claude-opus-4-7\`)
- \`system_prompt\` — 이 단계의 시스템 프롬프트 override. **여기서 거의 쓸모없음** — 3단계가 system prompt 를 소유. 드물게 쓰고 이유 문서화.
- \`max_tokens\` — 이 단계의 출력 cap
- \`temperature\` / \`top_p\` — 샘플링 제어

**모델 override 도 지원하는 다른 단계:** 2단계 (Context) 의 LLM 요약 compactor, 14단계 (Evaluate) 의 evaluator 전략, 18단계 (Memory) 의 reflective 요약기. override 메커니즘은 동일 — \`entry.model_override\` 는 지원하는 모든 단계의 stage-level 필드.`,
  configFields: [
    {
      name: 'model_override.model',
      label: '모델',
      type: 'string',
      description:
        'vendor + 모델 id, 예: `claude-opus-4-7-20260101` 또는 `gpt-5-1106`. 비어있음 / 미설정 = 파이프라인 기본값 상속.',
    },
    {
      name: 'model_override.system_prompt',
      label: '시스템 프롬프트',
      type: 'string',
      description:
        '단계별 시스템 프롬프트. 여기 설정하는 것은 거의 항상 잘못 — 3단계가 system prompt 를 소유. 예외는 이 단계가 파이프라인 나머지와 진짜 다른 persona / 지침이 필요할 때 (드묾).',
    },
    {
      name: 'model_override.max_tokens',
      label: 'Max tokens',
      type: 'integer',
      description:
        '이 단계의 출력 cap. 짧은 요약을 생산해야 하는 단계 (예: yes/no 를 반환하는 14단계 evaluator) 에 유용.',
    },
    {
      name: 'model_override.temperature',
      label: 'Temperature',
      type: 'number',
      description:
        '0 = 결정적, 1 = 창의적. 6단계 main-call 설정에 reasoning / 구조화 출력은 low (0–0.3), chat 은 mid (0.5–0.8).',
    },
    {
      name: 'model_override.top_p',
      label: 'Top-p',
      type: 'number',
      description:
        'Nucleus sampling. 대부분의 파이프라인은 **둘 중 하나** — temperature 또는 top_p — 만 선택하지 둘 다 쓰지 않음. 하나는 기본값으로, 다른 하나는 튜닝.',
    },
  ],
  options: [],
  relatedSections: [
    {
      label: '글로벌 모델 패널 (stage 리스트 위)',
      body: '파이프라인 레벨 기본값. 대부분의 파이프라인은 이것만 편집 — 단계별 override 는 기본값이 잘못된 특정 작업용.',
    },
    {
      label: '3단계 — System',
      body: '시스템 프롬프트는 model_override 가 아닌 여기. 3단계의 prompt builder 사용; override 의 `system_prompt` 필드는 진짜 단계별 예외 (드묾) 에만.',
    },
    {
      label: 'Advanced — `state.metadata["llm_overrides"]`',
      body: '런타임 / 턴 레벨 override 가 매니페스트 model_override 를 이김. 이번 턴의 state 를 기반으로 모델을 선택하는 adaptive router (14단계 전략) 가 사용. 매니페스트 override 가 *durable* 레이어; 런타임이 *dynamic* 레이어.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/core/stage.py:Stage.resolve_model_config',
};

export const stage06ModelOverrideHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
