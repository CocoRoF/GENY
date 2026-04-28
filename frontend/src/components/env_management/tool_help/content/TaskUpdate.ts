/** Tool detail — TaskUpdate (executor / tasks family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `TaskUpdate mutates a task's metadata after creation — name, priority, free-form notes, and (in some host implementations) tag-style annotations. The task's *execution* — command body, working dir, etc. — is immutable; if those need to change, stop the current task and create a new one.

The most common use case is annotation: the agent attached a task to a vague workflow ("run-tests-1234"), later figured out which feature it relates to, and wants to update the name / notes for future TaskList readability.

Priority is host-defined. Some implementations use it to reorder the run queue; others ignore it. The contract is "advisory hint" — never depend on priority for correctness.

Notes are free-form text and surface in TaskList / TaskGet output. They\'re a good place for "this task corresponds to PR #1234" or "started by sub-agent ROLE=reviewer".`,
  bestFor: [
    'Renaming / annotating a task post-hoc as the agent learns more about its purpose',
    'Marking task ownership when multiple sub-agents share the registry',
    'Adjusting priority when one task becomes more urgent',
  ],
  avoidWhen: [
    'You want to change what the task DOES — TaskStop + TaskCreate is the right path',
    'You want to mark complete — that happens automatically when the task finishes',
  ],
  gotchas: [
    'Task body is immutable. TaskUpdate can\'t change the command.',
    'Priority semantics are host-defined; never assume specific behaviour.',
    'Notes are not encrypted. Avoid embedding secrets / tokens.',
    'Updates to a completed task are usually allowed but cosmetic — they don\'t restart anything.',
  ],
  examples: [
    {
      caption: 'Annotate a task with PR context',
      body: `{
  "task_id": "tsk_a1b2c3",
  "name": "integration-tests-pr-1234",
  "notes": "Linked to PR #1234. Owner: reviewer sub-agent."
}`,
      note: 'Subsequent TaskList views show the new name and notes.',
    },
  ],
  relatedTools: ['TaskCreate', 'TaskList', 'TaskStop'],
  relatedStages: ['Stage 13 (Task registry)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/task_tools.py:TaskUpdateTool',
};

const ko: ToolDetailContent = {
  body: `TaskUpdate는 생성 후 task의 메타데이터를 mutate — 이름, 우선순위, 자유 형식 notes, 일부 호스트 구현은 태그 스타일 annotation. Task의 *실행* — 명령 본문, 작업 디렉토리 등 — 은 immutable; 그것들 변경 필요하면 현재 task 중단하고 새로 생성.

가장 흔한 사용 사례는 annotation: 에이전트가 모호한 워크플로("run-tests-1234")에 task 부착, 나중에 어떤 feature 관련인지 파악, 향후 TaskList 가독성을 위해 이름 / notes 업데이트.

우선순위는 호스트 정의. 일부 구현은 실행 queue 재정렬에 사용; 일부는 무시. 계약은 "advisory hint" — 정확성을 위해 우선순위 의존 절대 금지.

Notes는 자유 형식 텍스트로 TaskList / TaskGet 출력에 표면화. "이 task는 PR #1234에 해당" 또는 "sub-agent ROLE=reviewer가 시작" 같은 곳에 좋음.`,
  bestFor: [
    '에이전트가 task 목적을 더 학습한 후 사후 이름 변경 / annotation',
    '여러 sub-agent가 registry 공유 시 task 소유권 표시',
    '한 task가 더 긴급해질 때 우선순위 조정',
  ],
  avoidWhen: [
    'Task가 *하는 일* 변경 — TaskStop + TaskCreate가 적절한 경로',
    '완료 표시 — task 종료 시 자동 발생',
  ],
  gotchas: [
    'Task body는 immutable. TaskUpdate는 명령 변경 불가.',
    '우선순위 시맨틱은 호스트 정의; 특정 동작 가정 금지.',
    'Notes는 암호화 안 됨. 비밀 / 토큰 임베드 금지.',
    '완료된 task 업데이트는 보통 허용되지만 cosmetic — 어떤 것도 재시작 안 함.',
  ],
  examples: [
    {
      caption: 'PR 컨텍스트로 task annotation',
      body: `{
  "task_id": "tsk_a1b2c3",
  "name": "integration-tests-pr-1234",
  "notes": "PR #1234 연결. 소유자: reviewer sub-agent."
}`,
      note: '후속 TaskList 뷰가 새 이름과 notes 표시.',
    },
  ],
  relatedTools: ['TaskCreate', 'TaskList', 'TaskStop'],
  relatedStages: ['13단계 (Task registry)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/task_tools.py:TaskUpdateTool',
};

export const taskUpdateToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
