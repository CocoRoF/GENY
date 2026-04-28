/**
 * Help content for Stage 13 → Registry slot.
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Task registry',
  summary:
    "Where pending tasks are stored during this run. Stage 13 drains tasks from `state.shared[PENDING_TASKS_KEY]` and registers them with the chosen backend before the policy slot decides what to do with them.",
  whatItDoes: `Stage 13 sits in the agentic flow at the **task layer** — one level above tool calls, one level below the loop. The flow each turn:

1. Drain pending tasks from \`state.shared\` (queued by other stages or the host)
2. Register each task with the **registry** backend (this slot)
3. Run the **policy** (next slot) — fire-and-forget / eager wait / timed wait
4. Publish status snapshot to \`state.shared[TASKS_BY_STATUS_KEY]\`

The registry's job is the *storage* layer — once a task is registered, the policy can dispatch it, query its status, await its result. Different registries trade durability vs simplicity.`,
  options: [
    {
      id: 'in_memory',
      label: 'In-memory',
      description: `Process-lifetime store. Tasks live in a Python dict on the registry instance — no serialisation, no persistence, no IPC.

When the process exits (crash, restart, deploy), all task state is lost. The next run starts with an empty registry.

This is the only built-in registry today. Hosts that need durability would have to author their own registry implementation that talks to Redis / Postgres / a queue service.`,
      bestFor: [
        'Single-process pipelines — most agents fit here',
        'Pipelines where task state is incidental — if it survives the turn, that\'s enough',
        'Test setups',
      ],
      avoidWhen: [
        'You need cross-process / cross-restart task persistence — write a custom registry',
        'You need cross-pipeline task sharing — same answer, custom backend',
      ],
      gotchas: [
        'No size cap. Long-running pipelines that produce many tasks per turn will see the registry grow unbounded.',
        'Status snapshots are written to `state.shared[TASKS_BY_STATUS_KEY]` every turn — that snapshot is what survives via Stage 20 persistence. The registry itself doesn\'t.',
      ],
      codeRef:
        'geny-executor / s13_task_registry/artifact/default/registries.py:InMemoryRegistry',
    },
  ],
  relatedSections: [
    {
      label: 'Policy (next slot in this stage)',
      body: 'Registry stores tasks; policy decides what to do with them after registration (await? fire-and-forget? bounded wait?). Different concerns, both required for the stage to do anything useful.',
    },
    {
      label: 'Stage 20 — Persist',
      body: 'The registry doesn\'t persist itself, but the per-turn `state.shared[TASKS_BY_STATUS_KEY]` snapshot does (via the Stage 20 file persister). Restoring from a snapshot rebuilds the status view but NOT the registry — pending tasks are gone.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s13_task_registry/artifact/default/',
};

const ko: SectionHelpContent = {
  title: '작업 레지스트리 (Task registry)',
  summary:
    '이번 실행 동안 pending 작업이 저장되는 곳. 13단계가 \`state.shared[PENDING_TASKS_KEY]\` 에서 작업을 drain 해 선택된 backend 에 등록 후, policy 슬롯이 그것들로 무엇을 할지 결정.',
  whatItDoes: `13단계는 agentic 흐름의 **task 레이어** — 도구 호출 한 레벨 위, 루프 한 레벨 아래. 매 턴 흐름:

1. \`state.shared\` 에서 pending 작업 drain (다른 단계 또는 호스트가 큐잉)
2. **registry** backend (이 슬롯) 에 각 작업 등록
3. **policy** (다음 슬롯) 실행 — fire-and-forget / eager wait / timed wait
4. \`state.shared[TASKS_BY_STATUS_KEY]\` 에 status 스냅샷 발행

Registry 의 일은 *저장* 레이어 — 작업이 등록되면 policy 가 dispatch, 상태 쿼리, 결과 await 가능. 다른 registry 는 durability vs simplicity 를 trade.`,
  options: [
    {
      id: 'in_memory',
      label: '인메모리 (In-memory)',
      description: `프로세스 lifetime store. 작업이 registry 인스턴스의 Python dict 에 살음 — serialisation 없음, persistence 없음, IPC 없음.

프로세스가 종료되면 (크래시, 재시작, deploy) 모든 작업 상태 손실. 다음 실행은 빈 registry 로 시작.

오늘 유일한 built-in registry. durability 필요한 호스트는 Redis / Postgres / 큐 서비스와 talk 하는 자체 registry 구현 작성해야 함.`,
      bestFor: [
        '단일 프로세스 파이프라인 — 대부분 에이전트가 여기 적합',
        '작업 상태가 incidental 인 파이프라인 — 턴 동안 살면 충분',
        '테스트 setup',
      ],
      avoidWhen: [
        '프로세스 간 / 재시작 간 작업 persistence 필요할 때 — 커스텀 registry 작성',
        '파이프라인 간 작업 공유 필요할 때 — 같은 답, 커스텀 backend',
      ],
      gotchas: [
        '크기 cap 없음. 턴당 많은 작업을 생산하는 장기 파이프라인은 registry 가 무제한으로 자라는 것 봄.',
        'Status 스냅샷이 매 턴 `state.shared[TASKS_BY_STATUS_KEY]` 에 쓰여짐 — 그 스냅샷이 20단계 persistence 로 살아남음. Registry 자체는 안 됨.',
      ],
      codeRef:
        'geny-executor / s13_task_registry/artifact/default/registries.py:InMemoryRegistry',
    },
  ],
  relatedSections: [
    {
      label: '정책 (이 단계의 다음 슬롯)',
      body: 'Registry 가 작업 저장; policy 가 등록 후 작업으로 무엇을 할지 결정 (await? fire-and-forget? bounded wait?). 다른 관심사, 단계가 유용한 무엇을 하려면 둘 다 필요.',
    },
    {
      label: '20단계 — Persist',
      body: 'Registry 자체는 persist 안 되지만, 턴별 `state.shared[TASKS_BY_STATUS_KEY]` 스냅샷은 됨 (20단계 file persister 로). 스냅샷에서 restore 는 status 뷰 재빌드 하지만 registry 는 NOT — pending 작업 사라짐.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s13_task_registry/artifact/default/',
};

export const stage13RegistryHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
