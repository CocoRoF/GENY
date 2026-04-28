/**
 * Help content for Stage 7 → Calculator slot.
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Cost calculator',
  summary:
    "Converts the tracker's accumulated token counts into USD and adds to `state.total_cost_usd`. The calculator is what makes Stage 4's cost_budget guard fire and what surfaces money to the host's analytics.",
  whatItDoes: `Right after the tracker accumulates this turn's tokens, Stage 7 calls \`calculator.calculate(state.token_usage, state.model)\` and adds the result to \`state.total_cost_usd\`.

**The calculator's job is just multiplication** — it picks per-million-token rates from a pricing table keyed by model, multiplies, and accumulates. Different calculators differ in *which pricing table they use*.

**Cache pricing.** Anthropic charges differently for cache hits (~10% of normal input rate) and cache writes (~125% of normal). Calculators that have cache awareness apply those discounts; ones that don't treat cache reads/writes as regular input.

**Without Stage 7 running, every cost field stays at \`$0.00\`.** Stage 4's cost_budget guard never fires. Hosts that bill end-users by usage need this stage running.`,
  options: [
    {
      id: 'anthropic_pricing',
      label: 'Anthropic pricing',
      description: `Hardcoded Anthropic price table covering Claude family (Opus / Sonnet / Haiku, current and recent generations). Includes cache_read at 10% and cache_creation at 125% of input rate.

For Anthropic-only pipelines this is the most accurate option. For mixed-vendor pipelines, models the table doesn't recognise return \`$0\` — the calculator returns 0 for unknown model names rather than guessing.`,
      bestFor: [
        'Pure Anthropic pipelines — most accurate cost numbers',
        'Pipelines that need cache pricing accounting (cache_read discount, cache_creation premium)',
      ],
      avoidWhen: [
        'Mixed-vendor pipelines (Anthropic + OpenAI / Google) — non-Anthropic calls return $0, total_cost_usd will undercount',
      ],
      gotchas: [
        'The price table is **hardcoded at executor build time**. New Anthropic models won\'t have rates until the executor library is bumped. For brand-new models, switch to `custom_pricing` or `unified_pricing` until the rate ships.',
        'Unknown model names return $0, no error. Quick way to test: turn on a new model, watch `total_cost_usd` stay at $0 — that\'s your signal the table is stale.',
      ],
      codeRef:
        'geny-executor / s07_token/artifact/default/pricing.py:AnthropicPricingCalculator',
    },
    {
      id: 'custom_pricing',
      label: 'Custom flat rate',
      description: `A single input rate + single output rate, both in USD per million tokens. Provider-agnostic, completely model-agnostic — the same rate applies regardless of which model the call went to.

Rates are runtime-tunable via \`strategy_configs.calculator\` (configure() landed in PR #157). Cache reads/writes are NOT distinguished — they're charged at the input rate.`,
      bestFor: [
        'Self-hosted models (vLLM, Ollama) where you set the price based on your infrastructure cost, not a vendor\'s rate card',
        'Pipelines where exact pricing doesn\'t matter and you want to bill at a flat margin',
        'Quick demos / tests — set rates to 0 to ignore cost entirely',
      ],
      avoidWhen: [
        'You\'re paying real Anthropic / OpenAI bills — flat rate will diverge from actual invoices, especially on cache-heavy workloads',
      ],
      config: [
        {
          name: 'input_per_million',
          label: 'Input rate (USD / 1M tokens)',
          type: 'number',
          default: '3.0',
          description:
            'Multiplied by total input_tokens (cache or not — they\'re lumped together).',
        },
        {
          name: 'output_per_million',
          label: 'Output rate (USD / 1M tokens)',
          type: 'number',
          default: '15.0',
          description:
            'Multiplied by output_tokens.',
        },
      ],
      gotchas: [
        'Cache savings are invisible. If you switch from `anthropic_pricing` to `custom_pricing` and your workload is cache-heavy, the reported cost will go UP because cache_read is no longer discounted.',
      ],
      codeRef:
        'geny-executor / s07_token/artifact/default/pricing.py:CustomPricingCalculator',
    },
    {
      id: 'unified_pricing',
      label: 'Unified',
      description: `Multi-provider price table covering Anthropic + OpenAI + Google Gemini. Picks the right per-model rates from a single combined table; falls back to simple input/output (no cache) for non-Anthropic providers since OpenAI / Google don't expose cache pricing in the response.

For pipelines that mix vendors (e.g., Stage 6 main call on Claude, Stage 14 evaluator on cheap GPT), this is the right pick — it handles both.`,
      bestFor: [
        'Mixed-vendor pipelines (most agentic systems with cost-tier routing)',
        'Adaptive Stage 14 evaluators that switch models based on turn complexity',
        'Default for pipelines that may grow into multi-vendor over time',
      ],
      avoidWhen: [
        'Pure Anthropic pipelines — `anthropic_pricing` is slightly more focused, same accuracy',
      ],
      gotchas: [
        'Same hardcoded-table caveat as `anthropic_pricing` — new models cost $0 until the executor lib ships their rate.',
        'OpenAI / Google entries don\'t have cache rates because those providers do automatic caching transparently. So your Anthropic calls show cache savings; your OpenAI calls don\'t (even though they may be cached at the vendor).',
      ],
      codeRef:
        'geny-executor / s07_token/artifact/default/pricing.py:UnifiedPricingCalculator',
    },
  ],
  relatedSections: [
    {
      label: 'Tracker (previous slot in this stage)',
      body: 'Calculator multiplies what the tracker accumulated. Without the tracker filling `state.token_usage`, the calculator multiplies zeros.',
    },
    {
      label: 'Stage 4 — cost_budget guard',
      body: 'Stage 4\'s cost_budget guard reads `state.total_cost_usd` (the calculator\'s output). Disabling Stage 7 silently disables that guard.',
    },
    {
      label: 'Stage 5 — Cache',
      body: 'Cache hits / writes are recorded by the tracker (from `response.usage.cache_*_input_tokens`). Calculators with cache awareness (`anthropic_pricing`, `unified_pricing` for Anthropic models) apply the discount; `custom_pricing` doesn\'t.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s07_token/artifact/default/pricing.py',
};

const ko: SectionHelpContent = {
  title: '비용 계산기 (Cost calculator)',
  summary:
    'tracker 의 누적 토큰 카운트를 USD 로 변환하고 \`state.total_cost_usd\` 에 추가. calculator 가 4단계의 cost_budget guard 가 발화하게 하고 호스트 분석에 돈을 surface 하는 것.',
  whatItDoes: `tracker 가 이번 턴 토큰을 누적한 직후 7단계가 \`calculator.calculate(state.token_usage, state.model)\` 를 호출하고 결과를 \`state.total_cost_usd\` 에 추가.

**calculator 의 일은 곱셈일 뿐** — 모델 키의 백만 토큰당 요율을 가격 테이블에서 골라, 곱하고, 누적. 다른 calculator 들은 *어떤 가격 테이블을 쓰는지* 에서 다름.

**캐시 가격.** Anthropic 은 cache hit (정상 input rate 의 ~10%) 와 cache write (정상의 ~125%) 에 다르게 청구. cache 인식이 있는 calculator 는 그 할인 적용; 없는 것은 cache read/write 를 정상 input 으로 취급.

**7단계 실행 없이 모든 비용 필드는 \`$0.00\` 으로 유지.** 4단계의 cost_budget guard 가 절대 발화하지 않음. 사용량으로 최종 사용자에게 청구하는 호스트는 이 단계가 필요.`,
  options: [
    {
      id: 'anthropic_pricing',
      label: 'Anthropic 가격',
      description: `Claude 패밀리 (Opus / Sonnet / Haiku, 현재와 최근 세대) 를 커버하는 하드코딩된 Anthropic 가격 테이블. cache_read 는 input rate 의 10%, cache_creation 은 125% 포함.

Anthropic 전용 파이프라인에 가장 정확한 옵션. 멀티 벤더 파이프라인에서는 테이블이 인식 못 하는 모델은 \`$0\` 반환 — calculator 가 추측하기보다 unknown 모델 이름에 0 반환.`,
      bestFor: [
        '순수 Anthropic 파이프라인 — 가장 정확한 비용 숫자',
        '캐시 가격 회계가 필요한 파이프라인 (cache_read 할인, cache_creation 프리미엄)',
      ],
      avoidWhen: [
        '멀티 벤더 파이프라인 (Anthropic + OpenAI / Google) — 비-Anthropic 호출이 $0 반환, total_cost_usd 가 undercount',
      ],
      gotchas: [
        '가격 테이블은 **실행기 빌드 타임에 하드코딩**. 새 Anthropic 모델은 실행기 라이브러리가 bump 될 때까지 요율이 없음. 신규 모델은 요율이 ship 될 때까지 `custom_pricing` 또는 `unified_pricing` 으로 전환.',
        'Unknown 모델 이름은 에러 없이 $0 반환. 빠른 테스트: 새 모델 켜고 `total_cost_usd` 가 $0 으로 유지되는지 보기 — 테이블이 stale 한 신호.',
      ],
      codeRef:
        'geny-executor / s07_token/artifact/default/pricing.py:AnthropicPricingCalculator',
    },
    {
      id: 'custom_pricing',
      label: '커스텀 정액',
      description: `단일 input rate + 단일 output rate, 둘 다 백만 토큰당 USD. 프로바이더 무관, 완전 모델 무관 — 호출이 어느 모델로 갔든 같은 rate 적용.

요율은 \`strategy_configs.calculator\` 로 런타임 튜닝 가능 (PR #157 에서 configure() 추가). cache read/write 는 구분 안 됨 — input rate 로 청구.`,
      bestFor: [
        '벤더 rate card 가 아닌 인프라 비용 기반으로 가격을 설정하는 셀프 호스트 모델 (vLLM, Ollama)',
        '정확한 가격이 중요하지 않고 flat margin 으로 청구하고 싶은 파이프라인',
        '빠른 데모 / 테스트 — rate 를 0 으로 설정해 비용 완전 무시',
      ],
      avoidWhen: [
        '실제 Anthropic / OpenAI 청구를 지불하고 있을 때 — flat rate 가 실제 청구서와 차이 날 것, 특히 cache 무거운 워크로드에서',
      ],
      config: [
        {
          name: 'input_per_million',
          label: 'Input rate (USD / 1M 토큰)',
          type: 'number',
          default: '3.0',
          description:
            '총 input_tokens 와 곱해짐 (cache 여부 무관 — 함께 묶임).',
        },
        {
          name: 'output_per_million',
          label: 'Output rate (USD / 1M 토큰)',
          type: 'number',
          default: '15.0',
          description:
            'output_tokens 와 곱해짐.',
        },
      ],
      gotchas: [
        '캐시 절약이 보이지 않음. `anthropic_pricing` 에서 `custom_pricing` 으로 전환하고 워크로드가 cache 무거우면 보고된 비용이 OLD UP — cache_read 가 더 이상 할인되지 않으므로.',
      ],
      codeRef:
        'geny-executor / s07_token/artifact/default/pricing.py:CustomPricingCalculator',
    },
    {
      id: 'unified_pricing',
      label: '통합',
      description: `Anthropic + OpenAI + Google Gemini 를 커버하는 멀티 프로바이더 가격 테이블. 단일 결합 테이블에서 올바른 모델별 rate 를 선택; OpenAI / Google 이 응답에 cache 가격을 노출하지 않으므로 비-Anthropic 프로바이더는 단순 input/output (캐시 없음) 으로 fallback.

벤더를 섞는 파이프라인 (예: Claude 의 6단계 main call, 싼 GPT 의 14단계 evaluator) 에 옳은 선택 — 둘 다 처리.`,
      bestFor: [
        '멀티 벤더 파이프라인 (cost-tier 라우팅이 있는 대부분의 agentic 시스템)',
        '턴 복잡도 기반으로 모델을 전환하는 적응형 14단계 evaluator',
        '시간이 지나며 멀티 벤더로 성장할 수 있는 파이프라인의 기본값',
      ],
      avoidWhen: [
        '순수 Anthropic 파이프라인 — `anthropic_pricing` 이 약간 더 focused, 같은 정확도',
      ],
      gotchas: [
        '`anthropic_pricing` 과 동일한 하드코딩 테이블 caveat — 새 모델은 실행기 라이브러리가 그들의 rate 를 ship 할 때까지 $0.',
        'OpenAI / Google 항목은 cache rate 가 없음 — 그 프로바이더들은 자동 캐싱을 투명하게 함. 그래서 Anthropic 호출은 cache 절약을 보여주지만; OpenAI 호출은 안 보여줌 (vendor 에서 캐시 됐을 수도 있는데도).',
      ],
      codeRef:
        'geny-executor / s07_token/artifact/default/pricing.py:UnifiedPricingCalculator',
    },
  ],
  relatedSections: [
    {
      label: 'Tracker (이 단계의 이전 슬롯)',
      body: 'Calculator 가 tracker 가 누적한 것을 곱함. tracker 가 `state.token_usage` 를 채우지 않으면 calculator 는 0 을 곱함.',
    },
    {
      label: '4단계 — cost_budget guard',
      body: '4단계의 cost_budget guard 가 `state.total_cost_usd` (calculator 출력) 를 읽음. 7단계 비활성화는 그 guard 를 silent 하게 비활성화.',
    },
    {
      label: '5단계 — Cache',
      body: 'Cache hit / write 는 tracker 가 (`response.usage.cache_*_input_tokens` 에서) 기록. cache 인식 calculator (Anthropic 모델의 `anthropic_pricing`, `unified_pricing`) 가 할인 적용; `custom_pricing` 은 안 함.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s07_token/artifact/default/pricing.py',
};

export const stage07CalculatorHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
