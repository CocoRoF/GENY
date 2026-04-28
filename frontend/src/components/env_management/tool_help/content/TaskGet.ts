/** Tool detail — TaskGet (executor / tasks family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `TaskGet returns the current state of a task by ID — status, timestamps, exit code (when terminal), and a reference to its output. Use it as the polling primitive when the agent has fired a TaskCreate and wants to know whether it's done.

Status states:
  - \`pending\`: queued, not yet started (Stage 13 hasn't dispatched it)
  - \`running\`: actively executing
  - \`completed\`: finished successfully (exit code 0)
  - \`failed\`: terminated with non-zero exit code or unhandled exception
  - \`cancelled\`: TaskStop fired before completion

Returns metadata only — output blobs come via TaskOutput. This separation lets the agent poll status cheaply without re-fetching potentially-large output every turn.

For batch monitoring (many tasks at once), TaskList is more efficient than looping TaskGet — single round trip vs N.`,
  bestFor: [
    'Polling whether a previously-fired task is done',
    'Inspecting why a task failed (status + exit code)',
    'Pre-flight check before TaskOutput (skip if status != completed)',
  ],
  avoidWhen: [
    'Monitoring many tasks — TaskList is more efficient',
    'Reading the actual output — TaskOutput, not TaskGet',
  ],
  gotchas: [
    'Status updates can lag behind reality by a fraction of a second on busy systems.',
    'A failed task\'s exit_code is the OS exit code; for unhandled exceptions, exit code 1 is common but not guaranteed.',
    'Tasks have a retention window (typically 24-48h). After that, TaskGet returns "task not found" even for valid IDs.',
  ],
  examples: [
    {
      caption: 'Check if a task is done',
      body: `{
  "task_id": "tsk_a1b2c3"
}`,
      note: 'Returns {status, started_at, completed_at, exit_code}. Agent decides whether to TaskOutput next.',
    },
  ],
  relatedTools: ['TaskCreate', 'TaskList', 'TaskOutput', 'TaskStop'],
  relatedStages: ['Stage 13 (Task registry)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/task_tools.py:TaskGetTool',
};

const ko: ToolDetailContent = {
  body: `TaskGet은 ID로 task의 현재 상태를 반환 — 상태, 타임스탬프, 종료 코드(terminal일 때), 출력 참조. TaskCreate를 발사한 에이전트가 완료 여부 알고 싶을 때 polling primitive로 사용.

상태:
  - \`pending\`: queue됨, 아직 시작 안 함(13단계가 dispatch 안 함)
  - \`running\`: 활성 실행 중
  - \`completed\`: 성공적으로 완료(종료 코드 0)
  - \`failed\`: 비-zero 종료 코드 또는 처리 안 된 예외로 종료
  - \`cancelled\`: 완료 전 TaskStop 발화

메타데이터만 반환 — 출력 blob은 TaskOutput으로. 이 분리로 에이전트가 매 턴 잠재적으로 큰 출력 재fetch 없이 저렴하게 상태 polling 가능.

배치 모니터링(한 번에 많은 task)에는 TaskList가 TaskGet 루프보다 효율적 — 단일 round trip vs N.`,
  bestFor: [
    '이전에 발사된 task 완료 여부 polling',
    'Task 실패 이유 검사(상태 + 종료 코드)',
    'TaskOutput 전 사전 확인(상태 != completed면 skip)',
  ],
  avoidWhen: [
    '많은 task 모니터링 — TaskList가 더 효율적',
    '실제 출력 읽기 — TaskGet 아닌 TaskOutput',
  ],
  gotchas: [
    '바쁜 시스템에서 상태 업데이트가 실제보다 분수초 lag 가능.',
    '실패 task의 exit_code는 OS 종료 코드; 처리 안 된 예외는 보통 1이지만 보장 안 됨.',
    'Task는 retention window 있음(보통 24-48시간). 이후 TaskGet은 유효 ID여도 "task not found" 반환.',
  ],
  examples: [
    {
      caption: 'Task 완료 확인',
      body: `{
  "task_id": "tsk_a1b2c3"
}`,
      note: '{status, started_at, completed_at, exit_code} 반환. 에이전트가 다음 TaskOutput 여부 결정.',
    },
  ],
  relatedTools: ['TaskCreate', 'TaskList', 'TaskOutput', 'TaskStop'],
  relatedStages: ['13단계 (Task registry)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/task_tools.py:TaskGetTool',
};

export const taskGetToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
