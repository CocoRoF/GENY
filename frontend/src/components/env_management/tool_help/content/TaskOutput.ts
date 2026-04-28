/** Tool detail — TaskOutput (executor / tasks family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `TaskOutput fetches the captured stdout / stderr of a task. Works for running tasks (returns whatever has been emitted so far) and terminal tasks (returns the full final output). Separated from TaskGet so the agent can poll status cheaply without re-fetching potentially-large output.

Output streams:
  - \`stdout\`: standard output
  - \`stderr\`: standard error (separate stream — unlike Bash, tasks keep them disjoint)
  - \`combined\`: interleaved view, ordered by emit time

Pagination via \`offset\` (byte offset to start from) and \`limit\` (max bytes). Default returns the full buffer up to a host-configured cap (typically 1MB). For genuinely large outputs that exceed the buffer, the task should redirect to a file and the agent reads via Read.

For a streaming view (each call returns just the new bytes since last call), pass \`since: "last"\` — useful for long-running tasks where the agent wants to summarise progress incrementally.`,
  bestFor: [
    'Reading the result of a completed task',
    'Snapshotting in-progress task output for partial-progress reports',
    'Distinguishing stdout from stderr (Bash conflates them; tasks don\'t)',
  ],
  avoidWhen: [
    'Streaming a logfile in real time — Monitor + a file-redirected Bash run is more direct',
    'You haven\'t TaskGet\'d to verify the task exists / is in the right state',
    'Output is huge — write to a file in the task body and Read instead',
  ],
  gotchas: [
    'Output buffer is capped (~1MB typically). Tasks producing more truncate; the marker tells the agent so but the data is gone.',
    '`since: "last"` is host-tracked per (session, task) — sub-agents reading a parent\'s task get their own cursor.',
    'Stderr and stdout are separate streams. Some traditional Unix tools mix them; stay aware that a "no output" stdout might still have stderr content.',
    'Reading output from a still-running task returns "what\'s buffered now" — re-fetch later for more.',
  ],
  examples: [
    {
      caption: 'Read full stderr from a failed test run',
      body: `{
  "task_id": "tsk_a1b2c3",
  "stream": "stderr"
}`,
      note: 'Returns stderr only. Useful for failure diagnostics without wading through pytest\'s noisy stdout.',
    },
  ],
  relatedTools: ['TaskCreate', 'TaskGet', 'TaskList', 'TaskStop'],
  relatedStages: ['Stage 13 (Task registry)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/task_tools.py:TaskOutputTool',
};

const ko: ToolDetailContent = {
  body: `TaskOutput은 task의 캡처된 stdout / stderr를 fetch합니다. 실행 중 task(지금까지 emit된 것 반환)와 terminal task(풀 최종 출력 반환) 둘 다 작동. TaskGet과 분리되어 에이전트가 잠재적으로 큰 출력 재fetch 없이 저렴하게 상태 polling 가능.

출력 스트림:
  - \`stdout\`: 표준 출력
  - \`stderr\`: 표준 에러(별도 스트림 — Bash와 달리 task는 disjoint 유지)
  - \`combined\`: emit 시간 순서로 interleave된 뷰

\`offset\`(시작 byte offset)과 \`limit\`(최대 bytes)으로 페이지네이션. 기본은 호스트 설정 cap(보통 1MB)까지 풀 버퍼 반환. 진짜로 버퍼 초과하는 큰 출력은 task가 파일로 리다이렉트하고 에이전트가 Read로 읽기.

스트리밍 뷰(각 호출이 마지막 호출 이후 새 bytes만 반환)는 \`since: "last"\` 전달 — 에이전트가 점진적으로 진행 요약하고 싶은 장기 task에 유용.`,
  bestFor: [
    '완료된 task의 결과 읽기',
    '부분 진행 리포트용 진행 중 task 출력 스냅샷',
    'stdout과 stderr 구분(Bash는 합침; task는 안 합침)',
  ],
  avoidWhen: [
    '로그파일 실시간 스트리밍 — Monitor + 파일 리다이렉트 Bash 실행이 더 직접적',
    'Task 존재 / 적절한 상태 확인용 TaskGet 안 한 경우',
    '출력 거대 — task body에 파일로 쓰고 Read 사용',
  ],
  gotchas: [
    '출력 버퍼 cap(보통 ~1MB). 더 생성하는 task는 truncate; 마커가 에이전트에게 알리지만 데이터는 사라짐.',
    '`since: "last"`는 호스트가 (세션, task)별 추적 — 부모 task 읽는 sub-agent는 자체 cursor 가짐.',
    'Stderr와 stdout은 별도 스트림. 일부 전통 Unix 도구는 혼합; "출력 없음" stdout이 여전히 stderr 콘텐츠 가질 수 있음을 인지.',
    '여전히 실행 중인 task에서 출력 읽기는 "지금 버퍼된 것" 반환 — 더 보려면 나중에 재fetch.',
  ],
  examples: [
    {
      caption: '실패 테스트 실행의 풀 stderr 읽기',
      body: `{
  "task_id": "tsk_a1b2c3",
  "stream": "stderr"
}`,
      note: 'stderr만 반환. pytest의 noisy stdout 헤치지 않고 실패 진단에 유용.',
    },
  ],
  relatedTools: ['TaskCreate', 'TaskGet', 'TaskList', 'TaskStop'],
  relatedStages: ['13단계 (Task registry)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/task_tools.py:TaskOutputTool',
};

export const taskOutputToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
