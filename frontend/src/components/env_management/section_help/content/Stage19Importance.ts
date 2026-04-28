/**
 * Help content for Stage 19 → Importance grader slot.
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Importance grader',
  summary:
    "Assigns a severity grade (LOW / MEDIUM / HIGH / CRITICAL) to the turn summary. The grade is what Stage 20's `on_significant` frequency policy keys off, and what hosts use to triage their summary feeds.",
  whatItDoes: `Two grading approaches:

- **Fixed** — always emit the same grade. No logic, no extraction — useful when every turn matters equally (or doesn't).
- **Heuristic** — bump the grade based on simple signals (keyword presence, fact count, tool review errors).

Both are cheap (no LLM calls). The grade lands on the \`SummaryRecord.importance\` field; downstream code keys off it.`,
  options: [
    {
      id: 'fixed',
      label: 'Fixed',
      description: `Always returns the same configured grade. No inspection of the turn — every summary gets the same severity.

Default \`grade\` is MEDIUM. \`grade\` is runtime-tunable via \`strategy_configs.importance.grade\` (one of \`low\` / \`medium\` / \`high\` / \`critical\`).`,
      bestFor: [
        'Pipelines where every turn is equally important (or unimportant)',
        'Test setups where you want predictable grading',
        'Default — switch to heuristic only when grade actually varies meaningfully',
      ],
      avoidWhen: [
        'You want differential grading (some turns higher than others) — use heuristic',
      ],
      config: [
        {
          name: 'grade',
          label: 'Grade',
          type: 'select (low/medium/high/critical)',
          default: 'medium',
          description:
            'Importance grade applied to every summary this stage produces. Stored at `strategy_configs.importance.grade`.',
        },
      ],
      codeRef:
        'geny-executor / s19_summarize/artifact/default/importance.py:FixedImportance',
    },
    {
      id: 'heuristic',
      label: 'Heuristic',
      description: `Starts from a baseline (default MEDIUM) and bumps the grade based on signals:

- presence of \`high_keywords\` in the summary text → bump up
- presence of \`low_keywords\` → bump down
- fact count exceeds \`many_facts_threshold\` → bump up
- entity count exceeds \`many_entities_threshold\` → bump up
- tool_review surface errors this turn → escalate to HIGH (when \`escalate_on_tool_review_error=True\`)

Useful for pipelines where some turns genuinely matter more — the host can treat HIGH+CRITICAL summaries as alerts.`,
      bestFor: [
        'Customer-support agents where escalation signals matter',
        'Compliance pipelines where keyword presence is meaningful',
        'Anything where Stage 20\'s `on_significant` frequency policy should fire selectively',
      ],
      avoidWhen: [
        'Pipelines where heuristic signals are noisy — false escalations are worse than uniform grading',
      ],
      gotchas: [
        '`high_keywords` / `low_keywords` are NOT exposed in the curated UI — they\'re ctor-only on the executor side. Host must construct the heuristic with custom keyword lists or accept the empty defaults.',
      ],
      codeRef:
        'geny-executor / s19_summarize/artifact/default/importance.py:HeuristicImportance',
    },
  ],
  relatedSections: [
    {
      label: 'Summarizer (previous slot in this stage)',
      body: 'Importance grades the summary the summarizer produced. With `no_summary`, no record exists to grade.',
    },
    {
      label: 'Stage 20 — `on_significant` frequency',
      body: '`on_significant` checks `SummaryRecord.importance` against HIGH/CRITICAL to decide whether to checkpoint. Without an importance grader running, that branch never triggers.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s19_summarize/artifact/default/importance.py',
};

const ko: SectionHelpContent = {
  title: '중요도 평가 (Importance grader)',
  summary:
    '턴 요약에 severity 등급 (LOW / MEDIUM / HIGH / CRITICAL) 할당. 등급이 20단계의 \`on_significant\` 빈도 policy 가 key 로 사용하는 것이고, 호스트가 요약 피드 triage 에 쓰는 것.',
  whatItDoes: `두 grading 접근:

- **Fixed** — 항상 같은 등급 emit. 로직 없음, 추출 없음 — 모든 턴이 동등하게 중요할 때 (또는 안 할 때) 유용.
- **Heuristic** — 단순 신호 기반으로 등급 bump (키워드 존재, fact 카운트, tool review 에러).

둘 다 쌈 (LLM 호출 없음). 등급이 \`SummaryRecord.importance\` 필드에 land; 하류 코드가 그것에 key.`,
  options: [
    {
      id: 'fixed',
      label: '고정 (Fixed)',
      description: `항상 같은 구성된 등급 반환. 턴 inspect 없음 — 모든 요약이 같은 severity 받음.

기본 \`grade\` 는 MEDIUM. \`grade\` 는 \`strategy_configs.importance.grade\` 로 런타임 튜닝 가능 (\`low\` / \`medium\` / \`high\` / \`critical\` 중 하나).`,
      bestFor: [
        '모든 턴이 동등하게 중요한 (또는 안 한) 파이프라인',
        '예측 가능한 grading 원하는 테스트 setup',
        '기본값 — 등급이 의미 있게 변할 때만 heuristic 으로 전환',
      ],
      avoidWhen: [
        '차등 grading 원할 때 (어떤 턴은 다른 것보다 더 높음) — heuristic 사용',
      ],
      config: [
        {
          name: 'grade',
          label: '등급',
          type: 'select (low/medium/high/critical)',
          default: 'medium',
          description:
            '이 단계가 생산하는 모든 요약에 적용되는 중요도 등급. `strategy_configs.importance.grade` 에 저장.',
        },
      ],
      codeRef:
        'geny-executor / s19_summarize/artifact/default/importance.py:FixedImportance',
    },
    {
      id: 'heuristic',
      label: '휴리스틱 (Heuristic)',
      description: `기준선 (기본 MEDIUM) 에서 시작하고 신호 기반으로 등급 bump:

- 요약 텍스트의 \`high_keywords\` 존재 → bump up
- \`low_keywords\` 존재 → bump down
- Fact 카운트가 \`many_facts_threshold\` 초과 → bump up
- Entity 카운트가 \`many_entities_threshold\` 초과 → bump up
- 이번 턴 tool_review surface 에러 → HIGH 로 에스컬레이트 (\`escalate_on_tool_review_error=True\` 일 때)

어떤 턴이 진짜로 더 중요한 파이프라인에 유용 — 호스트가 HIGH+CRITICAL 요약을 알림으로 취급 가능.`,
      bestFor: [
        '에스컬레이션 신호가 중요한 고객 지원 에이전트',
        '키워드 존재가 의미 있는 컴플라이언스 파이프라인',
        '20단계의 `on_significant` 빈도 policy 가 선택적으로 발화해야 하는 모든 것',
      ],
      avoidWhen: [
        '휴리스틱 신호가 noisy 한 파이프라인 — 잘못된 에스컬레이션이 균일한 grading 보다 나쁨',
      ],
      gotchas: [
        '`high_keywords` / `low_keywords` 는 큐레이션된 UI 에 노출 안 됨 — 실행기 측에서 ctor 전용. 호스트가 커스텀 키워드 리스트로 휴리스틱 구성해야 함, 또는 빈 기본값 수용.',
      ],
      codeRef:
        'geny-executor / s19_summarize/artifact/default/importance.py:HeuristicImportance',
    },
  ],
  relatedSections: [
    {
      label: '요약기 (이 단계의 이전 슬롯)',
      body: 'Importance 가 summarizer 가 생산한 요약 등급 매김. `no_summary` 면 등급 매길 레코드가 존재 안 함.',
    },
    {
      label: '20단계 — `on_significant` 빈도',
      body: '`on_significant` 가 `SummaryRecord.importance` 를 HIGH/CRITICAL 와 체크해 체크포인트 할지 결정. Importance grader 실행 없이 그 branch 는 절대 trigger 안 됨.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s19_summarize/artifact/default/importance.py',
};

export const stage19ImportanceHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
