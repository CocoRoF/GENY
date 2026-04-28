/**
 * Help content for Stage 20 → Frequency policy slot.
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Checkpoint frequency',
  summary:
    "When to write a checkpoint. Persister decides WHERE; frequency decides WHEN. The choice trades durability (every turn) against IO cost (rare snapshots).",
  whatItDoes: `Each turn the frequency policy is asked: "should we checkpoint right now?". If yes, the persister runs; if no, the turn ends without writing.

Three flavours cover most cadence shapes: always (every_turn), periodic (every_n_turns), and event-driven (on_significant). They\'re mutually exclusive — pick the one that matches your durability needs.`,
  options: [
    {
      id: 'every_turn',
      label: 'Every turn',
      description: `Always returns true. Highest durability — every turn produces a checkpoint. Highest IO cost — every turn writes a JSON file (with file persister) or makes a write call (custom backends).

Useful for low-stakes pipelines where the IO cost is fine OR for development where you want every state to be inspectable.`,
      bestFor: [
        'Development / debugging — every state captured for inspection',
        'Short pipelines where total IO is bounded',
        'Pipelines using fast persistence backends (in-process databases, caching layers)',
      ],
      avoidWhen: [
        'High-volume production traffic — IO cost adds up quickly',
        'Long sessions — checkpoint files accumulate fast',
      ],
      codeRef:
        'geny-executor / s20_persist/artifact/default/frequencies.py:EveryTurnFrequency',
    },
    {
      id: 'every_n_turns',
      label: 'Every N turns',
      description: `Periodic checkpointing. Returns true on iterations \`0, N, 2N, 3N, …\`. Bounded by iteration count alone — no inspection of state contents.

Lower IO cost than every_turn, predictable cadence. Trade-off: if a crash happens between checkpoints, up to N-1 turns of state are lost.`,
      bestFor: [
        'Production agents that need durability without per-turn IO',
        'Long-running sessions where periodic snapshots are enough',
        'Default for most production pipelines',
      ],
      avoidWhen: [
        'You can\'t afford to lose any turn-level state — use every_turn',
        'You only care about specific events — use on_significant',
      ],
      config: [
        {
          name: 'n',
          label: 'N',
          type: 'integer',
          default: '5',
          description:
            'Persist on iterations 0, N, 2N, …  Stored at `strategy_configs.frequency.n`. The check is `state.iteration % N == 0`.',
        },
      ],
      gotchas: [
        'Iteration 0 always checkpoints (first turn of a session). If your `state.iteration` doesn\'t reset between sessions, this may not be the desired behaviour — check Stage 16\'s controller resets iteration appropriately.',
      ],
      codeRef:
        'geny-executor / s20_persist/artifact/default/frequencies.py:EveryNTurnsFrequency',
    },
    {
      id: 'on_significant',
      label: 'On significant',
      description: `Event-driven checkpointing. Returns true when:

- any event in \`significant_events\` was emitted this turn (matched against \`state.events\` + iteration)
- OR \`state.shared['tool_review_flags']\` contains an \`error\`-severity flag (Stage 11)
- OR \`state.shared['turn_summary'].importance\` is HIGH or CRITICAL (Stage 19, when \`escalate_on_high_importance=True\`)
- OR \`state.completion_signal\` is non-empty (terminal turn — last-turn snapshot)

Default \`significant_events\` covers HITL decisions / timeouts, tool_review flags, memory insight recordings, summary writes, and task failures — anything that\'s typically worth keeping a snapshot of.`,
      bestFor: [
        'Production pipelines with mixed turns — checkpoint only when something interesting happens',
        'Auditing — every checkpoint represents a meaningful state change',
        'Cost-sensitive workloads — most turns aren\'t significant, IO scales with significance not turn count',
      ],
      avoidWhen: [
        'Pipelines where ANY turn could be the last one you can recover (uniform criticality) — use every_turn or every_n_turns',
      ],
      config: [
        {
          name: 'significant_events',
          label: 'Significant event types',
          type: 'list[string]',
          default: 'default list (hitl/tool_review/memory/summary/task)',
          description:
            'Event types that trigger a checkpoint when emitted this turn. Empty list = use defaults. Stored at `strategy_configs.frequency.significant_events`.',
        },
        {
          name: 'escalate_on_high_importance',
          label: 'Escalate on HIGH/CRITICAL',
          type: 'boolean',
          default: 'true',
          description:
            'When true, also checkpoint when Stage 19\'s `turn_summary.importance` is HIGH or CRITICAL. Pairs naturally with Stage 19\'s heuristic importance grader.',
        },
      ],
      gotchas: [
        'Depends on Stage 19 (importance grader) being active for the importance escalation branch. Without Stage 19, that path is dead.',
        'Depends on Stage 11 (tool review) being active for the tool_review_flags branch. Without Stage 11, that path is dead too.',
        'The completion_signal branch fires on EVERY terminal turn — every session ends with a checkpoint, even short ones.',
      ],
      codeRef:
        'geny-executor / s20_persist/artifact/default/frequencies.py:OnSignificantFrequency',
    },
  ],
  relatedSections: [
    {
      label: 'Persister (previous slot)',
      body: 'Frequency tells persister to fire; persister stores. Both must be picked together — `no_persist` makes any frequency choice irrelevant.',
    },
    {
      label: 'Stage 19 — Importance grader',
      body: '`on_significant` keys off Stage 19\'s importance grade. Set Stage 19 to `heuristic` if you want HIGH/CRITICAL grades to drive checkpoint frequency.',
    },
    {
      label: 'Stage 11 — Tool review',
      body: '`on_significant` keys off Stage 11\'s `error`-severity flags. Tool review with high-severity flags acts as a "this turn matters" signal.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s20_persist/artifact/default/frequencies.py',
};

const ko: SectionHelpContent = {
  title: '체크포인트 빈도 (Frequency)',
  summary:
    '언제 체크포인트 쓸지. Persister 가 WHERE 결정; 빈도가 WHEN 결정. 선택이 durability (매 턴) 대 IO 비용 (드문 스냅샷) trade.',
  whatItDoes: `매 턴 빈도 policy 가 질문 받음: "지금 체크포인트 해야 하나?". Yes 면 persister 실행; no 면 쓰기 없이 턴 끝남.

세 flavour 가 대부분 cadence 모양 커버: 항상 (every_turn), 주기적 (every_n_turns), 이벤트 주도 (on_significant). 상호 배타적 — durability needs 매칭하는 것 선택.`,
  options: [
    {
      id: 'every_turn',
      label: '매 턴 (Every turn)',
      description: `항상 true 반환. 가장 높은 durability — 매 턴이 체크포인트 생산. 가장 높은 IO 비용 — 매 턴이 JSON 파일 쓰기 (file persister) 또는 쓰기 호출 (커스텀 backend).

IO 비용이 fine 인 low-stakes 파이프라인 또는 모든 state 가 inspect 가능하길 원하는 개발에 유용.`,
      bestFor: [
        '개발 / 디버깅 — 모든 state 가 inspection 위해 캡처',
        '총 IO 가 bounded 인 짧은 파이프라인',
        '빠른 persistence backend (in-process DB, 캐싱 레이어) 사용 파이프라인',
      ],
      avoidWhen: [
        '고볼륨 프로덕션 트래픽 — IO 비용 빠르게 누적',
        '장기 세션 — 체크포인트 파일이 빠르게 누적',
      ],
      codeRef:
        'geny-executor / s20_persist/artifact/default/frequencies.py:EveryTurnFrequency',
    },
    {
      id: 'every_n_turns',
      label: 'N 턴마다',
      description: `주기적 체크포인트. 반복 \`0, N, 2N, 3N, …\` 에서 true 반환. 반복 카운트만으로 bounded — state 내용 inspect 없음.

every_turn 보다 IO 비용 낮음, 예측 가능한 cadence. Trade-off: 체크포인트 사이에 크래시 일어나면 최대 N-1 턴의 state 손실.`,
      bestFor: [
        '턴별 IO 없이 durability 필요한 프로덕션 에이전트',
        '주기적 스냅샷으로 충분한 장기 세션',
        '대부분 프로덕션 파이프라인의 기본값',
      ],
      avoidWhen: [
        '어떤 턴 레벨 state 도 잃을 수 없을 때 — every_turn 사용',
        '특정 이벤트만 신경 쓸 때 — on_significant 사용',
      ],
      config: [
        {
          name: 'n',
          label: 'N',
          type: 'integer',
          default: '5',
          description:
            '반복 0, N, 2N, … 에서 persist. `strategy_configs.frequency.n` 에 저장. 체크는 `state.iteration % N == 0`.',
        },
      ],
      gotchas: [
        '반복 0 은 항상 체크포인트 (세션의 첫 턴). 세션 간 `state.iteration` 이 reset 안 되면 원하는 동작이 아닐 수 있음 — 16단계의 컨트롤러가 반복 적절히 reset 하는지 체크.',
      ],
      codeRef:
        'geny-executor / s20_persist/artifact/default/frequencies.py:EveryNTurnsFrequency',
    },
    {
      id: 'on_significant',
      label: '중요 신호 시 (On significant)',
      description: `이벤트 주도 체크포인트. 다음일 때 true 반환:

- 이번 턴에 \`significant_events\` 의 어떤 이벤트라도 emit 됨 (\`state.events\` + iteration 매칭)
- OR \`state.shared['tool_review_flags']\` 에 \`error\`-severity 플래그 있음 (11단계)
- OR \`state.shared['turn_summary'].importance\` 가 HIGH 또는 CRITICAL (19단계, \`escalate_on_high_importance=True\` 일 때)
- OR \`state.completion_signal\` 이 비어있지 않음 (terminal 턴 — 마지막-턴 스냅샷)

기본 \`significant_events\` 가 HITL 결정 / timeout, tool_review 플래그, 메모리 insight 기록, 요약 쓰기, 작업 실패 커버 — 일반적으로 스냅샷 보관할 가치 있는 모든 것.`,
      bestFor: [
        '혼합 턴의 프로덕션 파이프라인 — 흥미로운 일 일어날 때만 체크포인트',
        '감사 — 모든 체크포인트가 의미 있는 state 변경 나타냄',
        '비용 민감 워크로드 — 대부분 턴이 significant 안 함, IO 가 턴 카운트가 아닌 significance 로 scale',
      ],
      avoidWhen: [
        '모든 턴이 복구 가능해야 하는 마지막 턴일 수 있는 (균일한 criticality) 파이프라인 — every_turn 또는 every_n_turns 사용',
      ],
      config: [
        {
          name: 'significant_events',
          label: '중요 이벤트 타입',
          type: 'list[string]',
          default: '기본 리스트 (hitl/tool_review/memory/summary/task)',
          description:
            '이번 턴에 emit 되면 체크포인트 trigger 하는 이벤트 타입. 빈 리스트 = 기본값 사용. `strategy_configs.frequency.significant_events` 에 저장.',
        },
        {
          name: 'escalate_on_high_importance',
          label: 'HIGH/CRITICAL 시 escalate',
          type: 'boolean',
          default: 'true',
          description:
            'true 일 때 19단계의 `turn_summary.importance` 가 HIGH 또는 CRITICAL 일 때도 체크포인트. 19단계의 heuristic importance grader 와 자연스럽게 짝.',
        },
      ],
      gotchas: [
        'Importance escalation 분기는 19단계 (importance grader) 활성에 의존. 19단계 없으면 그 path 죽음.',
        'tool_review_flags 분기는 11단계 (tool review) 활성에 의존. 11단계 없으면 그 path 도 죽음.',
        'completion_signal 분기는 매 terminal 턴에 발화 — 모든 세션이 체크포인트로 끝남, 짧은 것도.',
      ],
      codeRef:
        'geny-executor / s20_persist/artifact/default/frequencies.py:OnSignificantFrequency',
    },
  ],
  relatedSections: [
    {
      label: '영속자 (이전 슬롯)',
      body: '빈도가 persister 에 발화하라 함; persister 가 저장. 둘 다 함께 선택 — `no_persist` 는 어떤 빈도 선택도 무관하게 만듦.',
    },
    {
      label: '19단계 — 중요도 평가',
      body: '`on_significant` 가 19단계의 중요도 등급에 key. HIGH/CRITICAL 등급이 체크포인트 빈도 driving 하길 원하면 19단계를 `heuristic` 으로 설정.',
    },
    {
      label: '11단계 — Tool review',
      body: '`on_significant` 가 11단계의 `error`-severity 플래그에 key. 고-severity 플래그의 tool review 가 "이 턴 중요" 신호로 작용.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s20_persist/artifact/default/frequencies.py',
};

export const stage20FrequencyHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
