/** Tool detail — EnterPlanMode (executor / meta family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `EnterPlanMode flips the agent into a read-only execution mode. While in plan mode, all destructive tools (Write, Edit, Bash, NotebookEdit, etc.) are blocked at dispatch time — the agent can still call read tools (Read, Grep, Glob, LSP, ToolSearch, WebFetch, WebSearch) and reason about them.

The intended pattern is "plan, then execute":
  1. Agent enters plan mode at the start of a task.
  2. Surveys the codebase / state with read-only tools.
  3. Produces a structured plan as text.
  4. Calls ExitPlanMode (with the plan as argument), which surfaces the plan to the user / parent for approval.
  5. Either the user approves and the agent continues with full tool access, or rejects and the agent re-plans.

This is the safety / transparency anchor for trust-building scenarios — the human sees what the agent intends to do *before* any side effects fire.

Plan mode is per-session, not per-stage. Every subsequent dispatch in this session checks the plan-mode flag until ExitPlanMode is called.`,
  bestFor: [
    'High-trust workflows where the user wants to see intent before action',
    'Onboarding flows where you want the human to validate the agent\'s plan',
    'Compliance scenarios where every destructive change needs explicit approval',
  ],
  avoidWhen: [
    'Headless / batch runs without a HITL operator — the loop will block',
    'Simple read-only queries where there\'s nothing to "execute" anyway',
  ],
  gotchas: [
    'Plan mode applies to the WHOLE session until ExitPlanMode. Forgetting to exit means subsequent runs stay read-only.',
    'Tools added by host plugins (GenyToolProvider / MCP) need to declare capabilities correctly — a tool without `read_only=true` will be blocked even if it\'s actually safe.',
    'Plan mode does not affect Agent (sub-agent) calls — the sub-agent inherits its own plan-mode state.',
  ],
  examples: [
    {
      caption: 'Enter plan mode at the start of a refactor task',
      body: `{}`,
      note: 'No arguments. Returns confirmation; subsequent destructive tool calls fail until ExitPlanMode.',
    },
  ],
  relatedTools: ['ExitPlanMode', 'ToolSearch'],
  relatedStages: ['Stage 4 (Permission guard)', 'Stage 15 (HITL)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/plan_mode_tool.py:EnterPlanModeTool',
};

const ko: ToolDetailContent = {
  body: `EnterPlanMode는 에이전트를 read-only 실행 모드로 전환합니다. 플랜 모드 중에는 destructive 도구(Write, Edit, Bash, NotebookEdit 등)가 dispatch 시점에 차단 — 에이전트는 read 도구(Read, Grep, Glob, LSP, ToolSearch, WebFetch, WebSearch)는 계속 호출하고 추론 가능.

의도된 패턴은 "plan, then execute":
  1. 작업 시작 시 에이전트가 plan mode 진입.
  2. read-only 도구로 코드베이스 / 상태 survey.
  3. 구조화된 플랜을 텍스트로 생성.
  4. ExitPlanMode 호출(플랜을 인자로) — 사용자 / 부모에게 승인용으로 플랜 표면화.
  5. 사용자 승인 시 에이전트가 풀 도구 액세스로 계속, 거부 시 재plan.

신뢰 형성 시나리오의 안전성 / 투명성 anchor — 사이드이펙트 발동 전에 사람이 에이전트의 의도를 봄.

Plan mode는 세션 단위, stage 단위 아님. ExitPlanMode 호출 전까지 이 세션의 모든 후속 dispatch가 plan-mode 플래그 체크.`,
  bestFor: [
    '액션 전 의도를 사용자에게 보여주고 싶은 고신뢰 워크플로',
    '사람이 에이전트의 플랜을 검증하길 원하는 온보딩',
    '모든 destructive 변경이 명시적 승인 필요한 컴플라이언스',
  ],
  avoidWhen: [
    'HITL operator 없는 헤드리스 / 배치 실행 — 루프 블록',
    '"실행"할 것이 애초에 없는 단순 read-only 쿼리',
  ],
  gotchas: [
    'Plan mode는 ExitPlanMode 전까지 전체 세션에 적용. 종료 잊으면 후속 실행이 read-only로 유지.',
    '호스트 플러그인이 추가한 도구(GenyToolProvider / MCP)는 capability를 정확히 선언해야 함 — `read_only=true` 없는 도구는 실제로 안전해도 차단.',
    'Plan mode는 Agent(sub-agent) 호출에 영향 없음 — sub-agent는 자체 plan-mode 상태 상속.',
  ],
  examples: [
    {
      caption: '리팩토링 작업 시작 시 plan mode 진입',
      body: `{}`,
      note: '인자 없음. 확인 반환; ExitPlanMode 호출 전까지 후속 destructive 도구 호출 실패.',
    },
  ],
  relatedTools: ['ExitPlanMode', 'ToolSearch'],
  relatedStages: ['4단계 (Permission guard)', '15단계 (HITL)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/plan_mode_tool.py:EnterPlanModeTool',
};

export const enterPlanModeToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
