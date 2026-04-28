/** Tool detail — TodoWrite (executor / workflow family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `TodoWrite is the agent's explicit task-plan tracker. The agent writes a numbered list of items, each with a status (\`pending\` / \`in_progress\` / \`completed\`), and the host renders it for the user. Subsequent calls completely replace the list — there is no per-item update API.

The state lives outside the manifest in a per-session todo store. The host UI typically shows it as a sidebar / sticky list so the user always sees what the agent thinks it's working on.

Status semantics:
  - \`pending\`: not started
  - \`in_progress\`: currently being worked on. Convention: at most one in_progress item at a time, so the user sees clear focus.
  - \`completed\`: done. Mark complete the moment work finishes; don't batch.

Common mistake: agents forget to update the list after finishing a step. Hosts often prompt the agent if the list is stale (no in_progress, no completed since last LLM call).

This tool is purely cosmetic — it doesn't gate execution. It exists for the user's benefit (visibility) and the agent's benefit (anchored attention across long, multi-step tasks).`,
  bestFor: [
    'Multi-step tasks where progress visibility matters',
    'Long sessions where the agent might lose track of subtasks',
    'User-trust scenarios — the user sees the plan unfolding in real time',
  ],
  avoidWhen: [
    'Single-step tasks ("read this file") — overhead without benefit',
    'High-frequency loops where rewriting the list per turn dominates the response',
  ],
  gotchas: [
    'TodoWrite REPLACES the entire list on every call. Always send the full current state, not just the changed item.',
    'Hosts conventionally show only one `in_progress` at a time — having multiple makes the focus signal noisy.',
    'Mark items complete the moment they finish; batching defeats the visibility purpose.',
    'The list is per-session. New sessions start with an empty list.',
  ],
  examples: [
    {
      caption: 'Update the plan after finishing step 2',
      body: `{
  "todos": [
    {"id": "1", "content": "Read auth module", "status": "completed"},
    {"id": "2", "content": "Rename verifyToken", "status": "completed"},
    {"id": "3", "content": "Run tests", "status": "in_progress"},
    {"id": "4", "content": "Open PR", "status": "pending"}
  ]
}`,
      note: 'Full list re-sent; host re-renders the todo panel.',
    },
  ],
  relatedTools: ['EnterPlanMode'],
  relatedStages: [],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/todo_write_tool.py:TodoWriteTool',
};

const ko: ToolDetailContent = {
  body: `TodoWrite는 에이전트의 명시적 task-plan 추적기. 에이전트가 번호 매긴 항목 리스트를 작성하고, 각 항목에 상태(\`pending\` / \`in_progress\` / \`completed\`)가 붙으며, 호스트가 사용자에게 렌더. 후속 호출은 리스트를 완전히 교체 — 항목별 업데이트 API 없음.

상태는 매니페스트 외부의 세션별 todo store에 저장. 호스트 UI는 보통 사이드바 / sticky 리스트로 표시해 에이전트가 무얼 작업 중이라 생각하는지 사용자가 항상 보게 함.

상태 시맨틱:
  - \`pending\`: 시작 안 함
  - \`in_progress\`: 현재 작업 중. 컨벤션: 한 번에 in_progress 최대 한 개, 명확한 포커스 표시.
  - \`completed\`: 완료. 작업 끝나는 즉시 완료 표시; 배치하지 마세요.

흔한 실수: 단계 완료 후 리스트 업데이트를 잊음. 호스트가 리스트가 stale하면(in_progress 없음, 마지막 LLM 호출 이후 completed 없음) 에이전트에게 prompt 거는 경우 많음.

이 도구는 순수 cosmetic — 실행을 gate하지 않음. 사용자(가시성)와 에이전트(긴 멀티스텝 작업의 앵커된 주의) 양쪽 이익을 위해 존재.`,
  bestFor: [
    '진행 가시성이 중요한 멀티스텝 작업',
    '에이전트가 sub-task를 놓칠 수 있는 긴 세션',
    '사용자 신뢰 시나리오 — 사용자가 실시간으로 플랜 전개를 봄',
  ],
  avoidWhen: [
    '단일 스텝 작업("이 파일 읽어") — 이익 없는 오버헤드',
    '리스트 재작성이 응답을 지배하는 고빈도 루프',
  ],
  gotchas: [
    'TodoWrite는 매 호출 시 전체 리스트를 교체. 변경 항목만 보내지 말고 항상 현재 전체 상태 전송.',
    '호스트는 관례적으로 한 번에 `in_progress` 하나만 표시 — 여러 개면 포커스 신호가 noisy.',
    '항목 완료 즉시 표시; 배치는 가시성 목적을 무력화.',
    '리스트는 세션 단위. 새 세션은 빈 리스트로 시작.',
  ],
  examples: [
    {
      caption: '단계 2 완료 후 플랜 업데이트',
      body: `{
  "todos": [
    {"id": "1", "content": "auth 모듈 read", "status": "completed"},
    {"id": "2", "content": "verifyToken 이름 변경", "status": "completed"},
    {"id": "3", "content": "테스트 실행", "status": "in_progress"},
    {"id": "4", "content": "PR 오픈", "status": "pending"}
  ]
}`,
      note: '전체 리스트 재전송; 호스트가 todo 패널 재렌더.',
    },
  ],
  relatedTools: ['EnterPlanMode'],
  relatedStages: [],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/todo_write_tool.py:TodoWriteTool',
};

export const todoWriteToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
