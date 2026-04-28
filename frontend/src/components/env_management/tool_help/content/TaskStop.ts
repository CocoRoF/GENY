/** Tool detail — TaskStop (executor / tasks family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `TaskStop terminates a running task. Sends SIGTERM first, waits a grace period (default 5 seconds), then SIGKILL if the task hasn't exited cleanly. The task's status transitions to \`cancelled\` and any captured output up to that point remains accessible via TaskOutput.

Use cases:
  - The task is no longer needed (the agent decided on a different approach mid-flight)
  - The task is misbehaving (consuming too much CPU / memory, stuck in a loop)
  - User asked to abort

Pending tasks (queued but not yet started) are simply removed from the queue without ever spawning. The status still flips to \`cancelled\` for consistency.

Already-terminal tasks (completed / failed / cancelled) return success without doing anything. The call is idempotent — re-running TaskStop on a task that already finished is safe.

\`force: true\` skips the grace period and SIGKILLs immediately. Reserve for genuinely stuck tasks; well-behaved tasks should clean up on SIGTERM and the grace period gives them that chance.`,
  bestFor: [
    'Cancelling a task the agent no longer needs',
    'Aborting runaway tasks consuming resources',
    'Cleanup before session end — fire TaskStop on remaining tasks',
  ],
  avoidWhen: [
    'The task is almost done — let it finish, then read TaskOutput',
    'You want to pause and resume — TaskStop is one-shot, not resumable',
  ],
  gotchas: [
    'Grace period only matters if the task installs a SIGTERM handler. CPU-bound Python loops without signal handling won\'t respond and will SIGKILL after grace.',
    '`cancelled` status doesn\'t distinguish "stopped because done" from "stopped via TaskStop". Inspect the agent\'s notes / parent context for intent.',
    'Output captured up to the kill point survives — partial output may be useful for diagnosing why the task was misbehaving.',
    'Stopping a task doesn\'t roll back side effects — files written, DB rows inserted, network calls made all stand.',
  ],
  examples: [
    {
      caption: 'Stop a runaway task',
      body: `{
  "task_id": "tsk_a1b2c3",
  "force": false
}`,
      note: 'SIGTERM, then SIGKILL after default grace period. Status becomes cancelled.',
    },
  ],
  relatedTools: ['TaskCreate', 'TaskGet', 'TaskList', 'TaskOutput'],
  relatedStages: ['Stage 13 (Task registry)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/task_tools.py:TaskStopTool',
};

const ko: ToolDetailContent = {
  body: `TaskStop은 실행 중인 task를 종료합니다. 먼저 SIGTERM 보내고, grace period(기본 5초) 대기, task가 깔끔히 종료 안 되면 SIGKILL. Task 상태는 \`cancelled\`로 전환되고 그 시점까지 캡처된 출력은 TaskOutput으로 계속 접근 가능.

사용 사례:
  - Task가 더 이상 필요 없음(에이전트가 도중에 다른 접근 결정)
  - Task가 오작동(CPU / 메모리 과소비, 루프에 stuck)
  - 사용자가 abort 요청

Pending task(queue됐지만 아직 시작 안 한)는 spawn 없이 단순히 queue에서 제거. 일관성 위해 상태는 여전히 \`cancelled\`로 flip.

이미 terminal인 task(completed / failed / cancelled)는 아무것도 안 하고 성공 반환. 호출은 idempotent — 이미 끝난 task에 TaskStop 재실행 안전.

\`force: true\`는 grace period 건너뛰고 즉시 SIGKILL. 진짜 stuck task에 한정; 잘 동작하는 task는 SIGTERM에서 정리해야 하고 grace period가 그 기회 제공.`,
  bestFor: [
    '에이전트가 더 필요 없는 task 취소',
    '리소스 소비하는 runaway task abort',
    '세션 종료 전 정리 — 남은 task에 TaskStop 발화',
  ],
  avoidWhen: [
    'Task가 거의 끝남 — 끝나게 두고 TaskOutput 읽기',
    '일시정지 후 재개 원함 — TaskStop은 one-shot, resumable 아님',
  ],
  gotchas: [
    'Grace period는 task가 SIGTERM 핸들러 설치한 경우만 의미. signal handling 없는 CPU-bound Python 루프는 응답 안 하고 grace 후 SIGKILL.',
    '`cancelled` 상태는 "끝나서 멈춤"과 "TaskStop으로 멈춤" 구분 안 함. 의도는 에이전트의 notes / 부모 컨텍스트 검사.',
    'Kill 시점까지 캡처된 출력은 살아남음 — 부분 출력이 task 오작동 원인 진단에 유용할 수 있음.',
    'Task 중단해도 사이드이펙트 롤백 안 함 — 작성된 파일, 삽입된 DB 행, 만들어진 네트워크 호출은 모두 그대로.',
  ],
  examples: [
    {
      caption: 'Runaway task 중단',
      body: `{
  "task_id": "tsk_a1b2c3",
  "force": false
}`,
      note: 'SIGTERM, 기본 grace period 후 SIGKILL. 상태가 cancelled로 됨.',
    },
  ],
  relatedTools: ['TaskCreate', 'TaskGet', 'TaskList', 'TaskOutput'],
  relatedStages: ['13단계 (Task registry)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/task_tools.py:TaskStopTool',
};

export const taskStopToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
