/**
 * Help content for Stage 7 → Tracker slot.
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Token tracker',
  summary:
    "Reads the per-call token usage from `state.last_api_response.usage` and rolls it into `state.token_usage`. The tracker is what makes Stage 4's token_budget guard, Stage 16's budget controllers, and Stage 7's cost calculation possible — without a tracker running, those all stay at zero.",
  whatItDoes: `Stage 6 (API) writes the LLM's response into \`state.last_api_response\` — including a \`usage\` field with input / output / cache token counts. Stage 7's tracker reads that and accumulates into \`state.token_usage\`:

\`\`\`
state.token_usage.input_tokens         += response.usage.input_tokens
state.token_usage.output_tokens        += response.usage.output_tokens
state.token_usage.cache_creation_input_tokens += ...
state.token_usage.cache_read_input_tokens     += ...
\`\`\`

After tracking, the calculator slot computes cost in USD and adds to \`state.total_cost_usd\`. Then the tracker also fires a \`token.usage\` event with the per-turn breakdown.

**Two trackers ship by default; both record the same totals — they differ in *what extra info* they store.**`,
  options: [
    {
      id: 'default',
      label: 'Default',
      description: `Reads \`response.usage\` and accumulates into \`state.token_usage\`. That's the entire job — no per-iteration history, no breakdowns, no extra metadata.

This is the right choice for ~95% of pipelines. The accumulated totals are what Stage 4 and Stage 16 actually need.`,
      bestFor: [
        'Most pipelines — accumulated totals cover all downstream needs',
        'Production pipelines where memory footprint matters (no per-iteration history retained)',
      ],
      avoidWhen: [
        'You\'re debugging cost spikes and want to know which iteration cost what — `detailed` retains that breakdown',
      ],
      gotchas: [
        'If `state.last_api_response.usage` is missing (mock providers, certain OpenAI streaming responses), the tracker silently records zeros for that turn. Stage 4\'s token_budget guard then has no signal to fire on.',
      ],
      codeRef:
        'geny-executor / s07_token/artifact/default/trackers.py:DefaultTracker',
    },
    {
      id: 'detailed',
      label: 'Detailed',
      description: `Same as Default plus a **per-iteration breakdown** stored at \`state.metadata["token_breakdown"]\`. Each entry records iteration index + this-call's input/output/cache numbers, so you can see e.g. "iteration 7 was the expensive one".

Useful for cost forensics, A/B testing prompt variants, or session-level analytics.`,
      bestFor: [
        'Debugging cost spikes — find which iteration ate the budget',
        'A/B testing prompt variants — compare per-turn cost across runs',
        'Session-level analytics dashboards (host reads `state.metadata.token_breakdown`)',
      ],
      avoidWhen: [
        'Long sessions with hundreds of turns — the breakdown list grows unbounded and lives in `state.metadata` (which gets snapshotted)',
      ],
      gotchas: [
        '`state.metadata.token_breakdown` is a list of dicts. It grows by one entry per iteration with no cap. For very long sessions this can bloat the snapshot file.',
      ],
      codeRef:
        'geny-executor / s07_token/artifact/default/trackers.py:DetailedTracker',
    },
  ],
  relatedSections: [
    {
      label: 'Calculator (next slot in this stage)',
      body: 'Tracker accumulates raw counts; calculator turns them into dollars. Without the tracker, the calculator has nothing to multiply against.',
    },
    {
      label: 'Stage 4 — Guard / Stage 16 — Loop',
      body: 'Both check `state.token_usage` against budgets. Tracker is what fills that struct — disabling Stage 7 disables those checks entirely (silently).',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s07_token/artifact/default/trackers.py',
};

const ko: SectionHelpContent = {
  title: '토큰 트래커 (Tracker)',
  summary:
    '\`state.last_api_response.usage\` 에서 호출별 토큰 사용량을 읽어 \`state.token_usage\` 로 누적. tracker 가 4단계의 token_budget guard, 16단계의 budget controller, 7단계의 비용 계산을 가능하게 하는 것 — tracker 없이 모두 0 으로 유지.',
  whatItDoes: `6단계 (API) 가 LLM 의 응답을 \`state.last_api_response\` 에 쓰는데 — input / output / cache 토큰 카운트가 있는 \`usage\` 필드 포함. 7단계의 tracker 가 그것을 읽고 \`state.token_usage\` 에 누적:

\`\`\`
state.token_usage.input_tokens         += response.usage.input_tokens
state.token_usage.output_tokens        += response.usage.output_tokens
state.token_usage.cache_creation_input_tokens += ...
state.token_usage.cache_read_input_tokens     += ...
\`\`\`

추적 후 calculator 슬롯이 USD 비용을 계산하고 \`state.total_cost_usd\` 에 추가. 그 다음 tracker 가 턴별 분해와 함께 \`token.usage\` 이벤트도 발화.

**기본 출하 트래커 둘; 둘 다 같은 totals 기록 — 다른 점은 *추가로 무엇을 저장*하는지.**`,
  options: [
    {
      id: 'default',
      label: '기본 (Default)',
      description: `\`response.usage\` 를 읽고 \`state.token_usage\` 에 누적. 그것이 전체 일 — 반복별 히스토리 없음, 분해 없음, 추가 메타데이터 없음.

파이프라인의 ~95% 에 옳은 선택. 누적 totals 가 4단계와 16단계가 실제로 필요로 하는 것.`,
      bestFor: [
        '대부분의 파이프라인 — 누적 totals 가 모든 하류 needs 커버',
        '메모리 footprint 가 중요한 프로덕션 파이프라인 (반복별 히스토리 보존 없음)',
      ],
      avoidWhen: [
        '비용 spike 를 디버깅하고 어느 반복이 얼마 비용인지 알고 싶을 때 — `detailed` 가 그 분해를 보존',
      ],
      gotchas: [
        '`state.last_api_response.usage` 가 없으면 (mock provider, 특정 OpenAI 스트리밍 응답) tracker 가 그 턴에 silent 하게 0 을 기록. 4단계의 token_budget guard 는 발화할 신호가 없어짐.',
      ],
      codeRef:
        'geny-executor / s07_token/artifact/default/trackers.py:DefaultTracker',
    },
    {
      id: 'detailed',
      label: '상세 (Detailed)',
      description: `Default 와 동일 + \`state.metadata["token_breakdown"]\` 에 저장되는 **반복별 분해**. 각 항목이 반복 인덱스 + 이 호출의 input/output/cache 숫자를 기록 — 예: "반복 7 이 비싼 것이었다" 를 알 수 있음.

비용 forensics, 프롬프트 변형 A/B 테스트, 세션 레벨 분석에 유용.`,
      bestFor: [
        '비용 spike 디버깅 — 어느 반복이 예산을 먹었는지 찾기',
        '프롬프트 변형 A/B 테스트 — 실행 간 턴별 비용 비교',
        '세션 레벨 분석 대시보드 (호스트가 `state.metadata.token_breakdown` 읽음)',
      ],
      avoidWhen: [
        '수백 턴의 장기 세션 — 분해 리스트가 무제한으로 늘어나고 `state.metadata` (스냅샷됨) 에 살음',
      ],
      gotchas: [
        '`state.metadata.token_breakdown` 은 dict 리스트. 반복당 한 항목씩 cap 없이 증가. 매우 긴 세션에서 스냅샷 파일을 부풀릴 수 있음.',
      ],
      codeRef:
        'geny-executor / s07_token/artifact/default/trackers.py:DetailedTracker',
    },
  ],
  relatedSections: [
    {
      label: 'Calculator (이 단계의 다음 슬롯)',
      body: 'Tracker 가 raw 카운트를 누적; calculator 가 그것을 달러로 전환. Tracker 없이 calculator 는 곱할 게 없음.',
    },
    {
      label: '4단계 — Guard / 16단계 — Loop',
      body: '둘 다 `state.token_usage` 를 예산과 비교. Tracker 가 그 struct 를 채우는 것 — 7단계 비활성화는 그 체크들을 (silent 하게) 통째로 비활성화.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s07_token/artifact/default/trackers.py',
};

export const stage07TrackerHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
