/**
 * Help content for Stage 13 → Policy slot.
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Execution policy',
  summary:
    "How registered tasks are awaited (or not). The choice trades **latency** (synchronous wait blocks the turn) against **completeness** (fire-and-forget returns immediately but with no result yet).",
  whatItDoes: `Once the registry has the task, the policy decides what happens next:

- **Fire-and-forget** — register and return. The task runs (or doesn't) asynchronously; this turn's pipeline continues without it.
- **Eager wait** — synchronously \`await\` each task before continuing. The turn blocks on task completion.
- **Timed wait** — bounded \`await\` per task with a timeout. Tasks that don't finish in time are abandoned (their status reflects this) and the turn continues.

The \`executor\` callable that actually *runs* the task is provided by the host via configure() — the policy doesn't ship its own runner. Without an executor, fire-and-forget is a no-op that just registers; eager_wait and timed_wait would block forever waiting for results from a non-existent runner.`,
  options: [
    {
      id: 'fire_and_forget',
      label: 'Fire & forget',
      description: `Register the task, return immediately. The turn doesn't wait for any result — the task may complete later (if anything is running it) or never.

Status updates flow through \`state.shared[TASKS_BY_STATUS_KEY]\` on subsequent turns as the registry's view of the task changes.`,
      bestFor: [
        'Pipelines where tasks are side-effect-only (e.g., async telemetry, background work) and the turn doesn\'t need their result',
        'Long-running tasks where you want the agent to keep working while they finish',
        'Default — simplest behaviour, no awaits',
      ],
      avoidWhen: [
        'You need the task\'s result in the same turn — use eager_wait or timed_wait',
      ],
      gotchas: [
        'Without a host-provided executor, registered tasks just sit there — the turn returns successfully but no work happens. Not an error, just a quiet no-op.',
      ],
      codeRef:
        'geny-executor / s13_task_registry/artifact/default/policies.py:FireAndForgetPolicy',
    },
    {
      id: 'eager_wait',
      label: 'Eager wait',
      description: `Synchronously await each registered task before the policy returns. The turn blocks on completion — slow tasks slow the turn.

Has \`configure()\` so the host can wire the task executor at restore-time. Without an executor, this policy hangs (no timeout fallback).`,
      bestFor: [
        'Pipelines where task results MUST be available for the next turn or downstream stages',
        'Linear workflows that conceptually run the task as part of the turn',
      ],
      avoidWhen: [
        'You can\'t bound task duration — eager_wait blocks indefinitely',
        'Stage 4\'s timeout-related guards are critical — eager_wait\'s blocking is invisible to wall-clock budgets',
      ],
      config: [
        {
          name: 'executor',
          label: 'Task executor',
          type: 'callable',
          required: true,
          description:
            'Host-provided async callable that actually runs the task. NOT manifest-encodable — host wires this at runtime via Pipeline.attach_runtime() or by passing the executor to configure() on policy instantiation.',
        },
      ],
      gotchas: [
        'No timeout. If a task hangs, eager_wait hangs. For hard deadlines use `timed_wait`.',
      ],
      codeRef:
        'geny-executor / s13_task_registry/artifact/default/policies.py:EagerWaitPolicy',
    },
    {
      id: 'timed_wait',
      label: 'Timed wait',
      description: `Like eager_wait but with a per-task \`timeout_seconds\` cap. Tasks that don't finish in time are abandoned (their status moves to "timeout") and the policy returns; the turn continues without their result.`,
      bestFor: [
        'Pipelines that need task results when available but can\'t risk the turn hanging',
        'Tool-using agents calling external services with unreliable latency',
        'Most production pipelines — bounded waits are usually safer than unbounded',
      ],
      avoidWhen: [
        'Tasks that genuinely take long but always finish — `eager_wait` saves the timeout overhead',
      ],
      config: [
        {
          name: 'executor',
          label: 'Task executor',
          type: 'callable',
          required: true,
          description:
            'Same as `eager_wait` — host-provided runner. Required.',
        },
        {
          name: 'timeout_seconds',
          label: 'Timeout (seconds)',
          type: 'number',
          default: '30',
          description:
            'Per-task hard cap. Manifest-tunable via `strategy_configs.policy.timeout_seconds` since PR #157.',
        },
      ],
      gotchas: [
        'Timeout is per-task, not per-turn-batch. If you have 10 tasks and timeout 30s, the worst-case turn duration is 300s.',
        'Timed-out tasks may still complete in the background after the timeout — their status will eventually reflect that, but the turn that timed them out won\'t see it.',
      ],
      codeRef:
        'geny-executor / s13_task_registry/artifact/default/policies.py:TimedWaitPolicy',
    },
  ],
  relatedSections: [
    {
      label: 'Registry (previous slot in this stage)',
      body: 'Registry stores task identities + state; policy decides whether the turn waits for them. Both required.',
    },
    {
      label: 'Stage 4 — Guard',
      body: 'Stage 4\'s budget guards are checked *before* Stage 13 runs. A long timed_wait can blow past wall-clock budgets the guards meant to enforce — they don\'t apply mid-stage.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s13_task_registry/artifact/default/policies.py',
};

const ko: SectionHelpContent = {
  title: '실행 정책 (Policy)',
  summary:
    '등록된 작업을 어떻게 await 할지 (또는 안 할지). 선택이 **레이턴시** (동기 wait 가 턴 차단) 와 **완전성** (fire-and-forget 은 즉시 반환하지만 결과 아직 없음) 을 trade.',
  whatItDoes: `Registry 가 작업을 가지면 policy 가 다음에 무엇이 일어날지 결정:

- **Fire-and-forget** — 등록하고 반환. 작업이 비동기로 실행 (또는 안 함); 이번 턴 파이프라인은 그것 없이 계속.
- **Eager wait** — 진행 전 각 작업을 동기 \`await\`. 턴이 작업 완료에 차단.
- **Timed wait** — 작업당 timeout 으로 bounded \`await\`. 시간 내 끝나지 않는 작업은 포기 (상태가 이를 반영) 하고 턴 계속.

작업을 실제로 *실행*하는 \`executor\` callable 은 호스트가 configure() 로 제공 — policy 는 자체 runner ship 안 함. executor 없이 fire-and-forget 은 등록만 하는 no-op; eager_wait 와 timed_wait 는 존재하지 않는 runner 의 결과를 영원히 기다림.`,
  options: [
    {
      id: 'fire_and_forget',
      label: 'Fire & forget',
      description: `작업 등록, 즉시 반환. 턴이 어떤 결과도 기다리지 않음 — 작업이 나중에 완료할 수도 (무언가 실행하면) 또는 안 함.

상태 업데이트는 registry 의 작업 뷰가 변하면서 후속 턴의 \`state.shared[TASKS_BY_STATUS_KEY]\` 로 흐름.`,
      bestFor: [
        '작업이 side-effect-only (예: 비동기 telemetry, 백그라운드 작업) 이고 턴이 그 결과 필요 없는 파이프라인',
        '에이전트가 그것들이 끝나는 동안 계속 작업하길 원하는 장기 작업',
        '기본값 — 가장 단순한 동작, await 없음',
      ],
      avoidWhen: [
        '같은 턴에 작업의 결과 필요할 때 — eager_wait 또는 timed_wait 사용',
      ],
      gotchas: [
        '호스트가 제공한 executor 없이 등록된 작업이 그냥 있음 — 턴이 성공적으로 반환되지만 작업 안 일어남. 에러 아님, 단순 quiet no-op.',
      ],
      codeRef:
        'geny-executor / s13_task_registry/artifact/default/policies.py:FireAndForgetPolicy',
    },
    {
      id: 'eager_wait',
      label: 'Eager wait',
      description: `Policy 반환 전 각 등록된 작업을 동기 await. 턴이 완료에 차단 — 느린 작업이 턴을 느리게 만듦.

호스트가 restore 시점에 task executor 를 wire 할 수 있도록 \`configure()\` 가짐. executor 없이 이 policy 는 hang (timeout fallback 없음).`,
      bestFor: [
        '작업 결과가 다음 턴 또는 하류 단계에 사용 가능해야 하는 파이프라인',
        '개념적으로 작업을 턴의 일부로 실행하는 선형 워크플로',
      ],
      avoidWhen: [
        '작업 시간을 bound 할 수 없을 때 — eager_wait 가 무제한 차단',
        '4단계의 timeout 관련 guard 가 critical 할 때 — eager_wait 의 차단은 wall-clock 예산에 보이지 않음',
      ],
      config: [
        {
          name: 'executor',
          label: '작업 실행기',
          type: 'callable',
          required: true,
          description:
            '실제로 작업을 실행하는 호스트 제공 async callable. 매니페스트 인코딩 불가 — 호스트가 Pipeline.attach_runtime() 또는 policy 인스턴스 생성 시 configure() 에 executor 전달로 런타임에 wire.',
        },
      ],
      gotchas: [
        'Timeout 없음. 작업이 hang 하면 eager_wait 가 hang. Hard deadline 은 `timed_wait` 사용.',
      ],
      codeRef:
        'geny-executor / s13_task_registry/artifact/default/policies.py:EagerWaitPolicy',
    },
    {
      id: 'timed_wait',
      label: 'Timed wait',
      description: `eager_wait 와 같지만 작업당 \`timeout_seconds\` cap. 시간 내 끝나지 않는 작업은 포기 (상태가 "timeout" 으로 이동) 하고 policy 반환; 턴이 그것들의 결과 없이 계속.`,
      bestFor: [
        '사용 가능할 때 작업 결과 필요하지만 턴이 hang 할 위험 없어야 하는 파이프라인',
        '신뢰할 수 없는 latency 의 외부 서비스를 호출하는 도구 사용 에이전트',
        '대부분의 프로덕션 파이프라인 — bounded wait 가 보통 unbounded 보다 안전',
      ],
      avoidWhen: [
        '진짜 오래 걸리지만 항상 끝나는 작업 — `eager_wait` 가 timeout 오버헤드 절약',
      ],
      config: [
        {
          name: 'executor',
          label: '작업 실행기',
          type: 'callable',
          required: true,
          description:
            '`eager_wait` 와 동일 — 호스트 제공 runner. 필수.',
        },
        {
          name: 'timeout_seconds',
          label: 'Timeout (초)',
          type: 'number',
          default: '30',
          description:
            '작업당 hard cap. PR #157 부터 `strategy_configs.policy.timeout_seconds` 로 매니페스트 튜닝 가능.',
        },
      ],
      gotchas: [
        'Timeout 은 작업당, 턴-batch 당 아님. 10 작업과 timeout 30s 가 있으면 worst-case 턴 duration 은 300s.',
        'Timed-out 작업은 timeout 후 백그라운드에서 여전히 완료 가능 — 상태가 결국 그것을 반영하지만, 그것들을 timeout 한 턴은 못 봄.',
      ],
      codeRef:
        'geny-executor / s13_task_registry/artifact/default/policies.py:TimedWaitPolicy',
    },
  ],
  relatedSections: [
    {
      label: 'Registry (이 단계의 이전 슬롯)',
      body: 'Registry 가 작업 정체성 + state 저장; policy 가 턴이 그것들을 기다릴지 결정. 둘 다 필요.',
    },
    {
      label: '4단계 — Guard',
      body: '4단계의 예산 guard 는 13단계 실행 *전*에 체크됨. 긴 timed_wait 가 guard 가 강제하려던 wall-clock 예산을 폭파 가능 — 단계 중간에 적용 안 됨.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s13_task_registry/artifact/default/policies.py',
};

export const stage13PolicyHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
