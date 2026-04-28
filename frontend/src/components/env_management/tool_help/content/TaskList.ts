/** Tool detail — TaskList (executor / tasks family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `TaskList enumerates tasks in the registry, filtered by status and ownership. Returns task metadata in batch — status, name, start time, the same fields TaskGet exposes per-ID — but covers many tasks in a single call.

Filters:
  - \`status\`: \`pending\` / \`running\` / \`completed\` / \`failed\` / \`cancelled\` / \`all\` (default omits cancelled + completed older than 1h to keep responses bounded)
  - \`name_pattern\`: glob over task name (\`build-*\`, \`*-tests\`, etc.)
  - \`session_only\`: scope to tasks created in the current AgentSession (default true; set false to see tasks from other sessions on the same host)

Output is paginated. Default \`limit\` is 50; pass higher for bulk queries. Sorted newest-first.

This is the right primitive for fan-out monitoring: agent fires N tasks, then loops "TaskList(running) → if empty, all done; else check progress" instead of polling each task individually.`,
  bestFor: [
    'Monitoring multiple concurrent tasks',
    'Auditing what tasks the agent has fired in this session',
    'Pre-flight before kicking off more work — "are too many already running?"',
    'Cleaning up stale tasks via TaskStop after listing failures',
  ],
  avoidWhen: [
    'You only care about one specific task — TaskGet is more direct',
    'You need full output — TaskList returns metadata only',
  ],
  gotchas: [
    'Default filters hide old completed/cancelled tasks; pass `status: "all"` for the unfiltered view.',
    'Pagination is mandatory for large registries — 50 is the default and only the first page is returned.',
    'Cross-session view (`session_only: false`) requires permission — locked-down deployments may refuse.',
    'Sort order is newest-first; rely on the per-task `started_at` for absolute ordering.',
  ],
  examples: [
    {
      caption: 'List currently-running tasks in this session',
      body: `{
  "status": "running",
  "session_only": true
}`,
      note: 'Returns metadata for each running task; agent can decide who to TaskGet / TaskOutput on next.',
    },
  ],
  relatedTools: ['TaskCreate', 'TaskGet', 'TaskOutput', 'TaskStop'],
  relatedStages: ['Stage 13 (Task registry)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/task_tools.py:TaskListTool',
};

const ko: ToolDetailContent = {
  body: `TaskList는 registry의 task를 status와 소유권으로 필터링해 enumerate합니다. task 메타데이터를 배치로 반환 — TaskGet이 ID당 노출하는 같은 필드(상태, 이름, 시작 시각)지만 단일 호출로 많은 task 커버.

필터:
  - \`status\`: \`pending\` / \`running\` / \`completed\` / \`failed\` / \`cancelled\` / \`all\`(기본은 cancelled와 1시간 이상 된 completed 제외해 응답 크기 제한)
  - \`name_pattern\`: task 이름에 대한 glob(\`build-*\`, \`*-tests\` 등)
  - \`session_only\`: 현재 AgentSession에서 생성된 task로 범위 제한(기본 true; false로 같은 호스트의 다른 세션 task 보기)

출력은 페이지네이션. 기본 \`limit\`은 50; 벌크 쿼리는 더 높게 전달. 최신 우선 정렬.

Fan-out 모니터링의 적절한 primitive: 에이전트가 N개 task 발사, 각 task 개별 polling 대신 "TaskList(running) → 비어있으면 모두 완료; 아니면 진행 확인" 루프.`,
  bestFor: [
    '여러 동시 task 모니터링',
    '이 세션에서 에이전트가 발사한 task 감사',
    '더 많은 작업 전 사전 확인 — "이미 너무 많이 실행 중?"',
    '실패 listing 후 TaskStop으로 stale task 정리',
  ],
  avoidWhen: [
    '특정 task 하나만 관심 — TaskGet이 더 직접적',
    '풀 출력 필요 — TaskList는 메타데이터만 반환',
  ],
  gotchas: [
    '기본 필터가 오래된 completed/cancelled task 숨김; 필터 안 된 뷰는 `status: "all"` 전달.',
    '큰 registry는 페이지네이션 필수 — 50이 기본이고 첫 페이지만 반환.',
    'Cross-session 뷰(`session_only: false`)는 permission 필요 — 잠긴 배포는 거부 가능.',
    '정렬 순서 최신 우선; 절대 순서는 task별 `started_at` 의존.',
  ],
  examples: [
    {
      caption: '이 세션의 실행 중인 task list',
      body: `{
  "status": "running",
  "session_only": true
}`,
      note: '각 실행 중 task 메타데이터 반환; 에이전트가 다음에 TaskGet / TaskOutput할 대상 결정.',
    },
  ],
  relatedTools: ['TaskCreate', 'TaskGet', 'TaskOutput', 'TaskStop'],
  relatedStages: ['13단계 (Task registry)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/task_tools.py:TaskListTool',
};

export const taskListToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
