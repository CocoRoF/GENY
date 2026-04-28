/** Tool detail — TaskCreate (executor / tasks family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `TaskCreate registers a long-running task in Stage 13's task registry. Unlike Bash run_in_background (which spawns a process the agent has to babysit via Monitor + logfile), tasks have first-class identity: a task ID, a status timeline, and structured output the agent can fetch later via TaskGet / TaskOutput.

Tasks survive across multiple agent turns — TaskCreate fires-and-forgets, the agent does other work, then comes back via TaskGet to check status. They also survive sub-agent boundaries (parent creates, child observes; or parent + child both observe a long-running pipeline).

Task body can be:
  - A shell command (executes in the worktree's CWD via the same shell as Bash)
  - A registered task type (when the host has registered ones via SubagentTypeRegistry-style descriptors)

Stage 13's policy slot decides scheduling:
  - \`fire_and_forget\` (default): start now, never block
  - \`eager_wait\`: start now, the next turn waits up to a budget for completion
  - \`timed_wait\`: same, but with a configurable timeout

Returns the task ID immediately. Status starts as \`pending\` (queued) → \`running\` → \`completed\` or \`failed\`.`,
  bestFor: [
    'Long operations the agent doesn\'t need to babysit (training jobs, data pipelines, large compiles)',
    'Cross-turn coordination — kick off, do other work, check back',
    'Parallel work fan-out — create N tasks, TaskList to monitor, TaskOutput to gather results',
  ],
  avoidWhen: [
    'The work finishes in seconds — Bash with a small timeout is simpler',
    'You need real-time output streaming — Monitor a logfile from Bash run_in_background',
    'You need synchronous result before continuing — call Bash directly, don\'t TaskCreate then immediately TaskGet',
  ],
  gotchas: [
    'Default fire_and_forget policy means even if the task fails immediately, the agent finds out only on next TaskGet.',
    'Tasks share the executor process\'s resources — too many concurrent tasks can starve other tools.',
    'Output is captured but capped (typical 10MB). For genuinely large outputs, write to a file and TaskOutput returns a pointer.',
    'Worktree state at TaskCreate is what the task sees. Subsequent EnterWorktree / ExitWorktree don\'t affect a running task.',
  ],
  examples: [
    {
      caption: 'Kick off a long-running test suite',
      body: `{
  "command": "pytest tests/integration -v",
  "name": "integration-tests",
  "policy": "fire_and_forget"
}`,
      note: 'Returns task_id immediately. Agent does other work, then TaskGet(task_id) to check status.',
    },
  ],
  relatedTools: ['TaskGet', 'TaskList', 'TaskOutput', 'TaskUpdate', 'TaskStop'],
  relatedStages: ['Stage 13 (Task registry)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/task_tools.py:TaskCreateTool',
};

const ko: ToolDetailContent = {
  body: `TaskCreate는 13단계 task registry에 장기 실행 task를 등록합니다. Bash run_in_background(에이전트가 Monitor + logfile로 babysit해야 하는 프로세스 spawn)와 달리, task는 first-class identity 보유: task ID, 상태 타임라인, 에이전트가 TaskGet / TaskOutput으로 나중에 fetch 가능한 구조화된 출력.

Task는 여러 에이전트 턴 가로질러 살아남음 — TaskCreate가 fire-and-forget, 에이전트가 다른 작업하다가 TaskGet으로 돌아와 상태 확인. Sub-agent 경계도 가로지름(부모가 생성, 자식이 관찰; 또는 부모와 자식 모두 장기 파이프라인 관찰).

Task body는:
  - 셸 명령(worktree의 CWD에서 Bash와 같은 셸로 실행)
  - 등록된 task 타입(호스트가 SubagentTypeRegistry 스타일 descriptor로 등록한 경우)

13단계의 policy slot이 스케줄링 결정:
  - \`fire_and_forget\`(기본): 지금 시작, 절대 블록 안 함
  - \`eager_wait\`: 지금 시작, 다음 턴이 완료까지 예산 내에서 대기
  - \`timed_wait\`: 같지만 설정 가능한 timeout

Task ID 즉시 반환. 상태는 \`pending\`(queue됨) → \`running\` → \`completed\` 또는 \`failed\`로 시작.`,
  bestFor: [
    '에이전트가 babysit 불필요한 장기 작업(학습 잡, 데이터 파이프라인, 큰 컴파일)',
    '턴 간 조율 — 시작, 다른 작업, 다시 확인',
    '병렬 작업 fan-out — N개 task 생성, TaskList로 모니터, TaskOutput으로 결과 수집',
  ],
  avoidWhen: [
    '작업이 초 단위로 끝남 — 작은 timeout의 Bash가 더 간단',
    '실시간 출력 스트리밍 필요 — Bash run_in_background의 logfile을 Monitor',
    '계속하기 전 동기 결과 필요 — Bash 직접 호출, TaskCreate 후 즉시 TaskGet 금지',
  ],
  gotchas: [
    '기본 fire_and_forget 정책은 task가 즉시 실패해도 다음 TaskGet에서야 에이전트가 알게 됨.',
    'Task는 실행기 프로세스의 리소스 공유 — 동시 task 너무 많으면 다른 도구 starve 가능.',
    '출력 캡처되지만 cap(보통 10MB). 진짜 큰 출력은 파일에 쓰고 TaskOutput이 포인터 반환.',
    'TaskCreate 시점의 worktree 상태가 task가 보는 것. 후속 EnterWorktree / ExitWorktree는 실행 중 task에 영향 없음.',
  ],
  examples: [
    {
      caption: '장기 실행 테스트 스위트 시작',
      body: `{
  "command": "pytest tests/integration -v",
  "name": "integration-tests",
  "policy": "fire_and_forget"
}`,
      note: 'task_id 즉시 반환. 에이전트가 다른 작업 후 TaskGet(task_id)로 상태 확인.',
    },
  ],
  relatedTools: ['TaskGet', 'TaskList', 'TaskOutput', 'TaskUpdate', 'TaskStop'],
  relatedStages: ['13단계 (Task registry)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/task_tools.py:TaskCreateTool',
};

export const taskCreateToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
