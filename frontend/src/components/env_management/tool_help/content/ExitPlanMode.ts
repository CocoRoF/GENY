/** Tool detail — ExitPlanMode (executor / meta family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `ExitPlanMode is the second half of the plan-mode contract. The agent calls it with the structured plan it produced during EnterPlanMode; the host surfaces the plan to the user (or parent agent) for approval.

Three outcomes from the host's perspective:

  1. **Approve**: plan mode lifts; subsequent dispatches have full tool access; the agent continues executing the plan.
  2. **Reject**: plan mode stays on; the agent receives a rejection signal in its tool result and is expected to re-plan or abandon.
  3. **Ask for changes**: the host can return modification feedback in the tool result; the agent revises and calls ExitPlanMode again.

The \`plan\` argument is free-form text — markdown is conventional. Some host frontends render it specially (numbered steps, tool intent, file targets). Best-practice plans:
  - List concrete steps in order
  - Name each tool the agent intends to call
  - Identify each file / external system the agent will touch
  - Surface known risks ("this will overwrite X")`,
  bestFor: [
    'Closing the EnterPlanMode → ExitPlanMode loop with a plan summary',
    'Pausing before destructive work for explicit human go-ahead',
  ],
  avoidWhen: [
    'You\'re not in plan mode — the call is a no-op',
    'You don\'t have an actual plan yet — go gather more context with read tools first',
  ],
  gotchas: [
    'A rejected plan keeps plan mode ACTIVE. The agent must call ExitPlanMode again with a revised plan after gathering more info.',
    'The plan argument is shown to the human; avoid leaking secrets / api keys in the description.',
    'Some hosts auto-approve plan-mode exits in headless runs; check your host\'s config before relying on the gate.',
  ],
  examples: [
    {
      caption: 'Surface a refactor plan for approval',
      body: `{
  "plan": "1. Read src/auth.ts and src/auth.test.ts\\n2. Edit src/auth.ts: rename verifyToken → validateToken (replace_all)\\n3. Edit src/auth.test.ts: same rename\\n4. Run pytest -k auth\\n\\nFiles touched: src/auth.ts, src/auth.test.ts. No external systems."
}`,
      note: 'Host shows the plan; user approves or rejects.',
    },
  ],
  relatedTools: ['EnterPlanMode'],
  relatedStages: ['Stage 4 (Permission guard)', 'Stage 15 (HITL)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/plan_mode_tool.py:ExitPlanModeTool',
};

const ko: ToolDetailContent = {
  body: `ExitPlanMode는 plan-mode 계약의 후반부. 에이전트가 EnterPlanMode 동안 생성한 구조화된 플랜과 함께 호출; 호스트가 플랜을 사용자(또는 부모 에이전트)에게 승인용으로 표면화.

호스트 관점에서 세 결과:

  1. **승인**: plan mode 해제; 후속 dispatch가 풀 도구 액세스; 에이전트가 플랜 실행 계속.
  2. **거부**: plan mode 유지; 에이전트가 tool result로 거부 신호 받고, 재plan 또는 abandon 기대.
  3. **수정 요청**: 호스트가 tool result로 modification feedback 반환; 에이전트가 수정 후 ExitPlanMode 재호출.

\`plan\` 인자는 free-form 텍스트 — 마크다운 관례. 일부 호스트 프론트엔드는 특별히 렌더(번호 매긴 단계, 도구 의도, 파일 타겟). Best-practice 플랜:
  - 구체적 단계를 순서대로 나열
  - 에이전트가 호출할 각 도구 이름
  - 에이전트가 건드릴 각 파일 / 외부 시스템 식별
  - 알려진 위험 표면화("X를 덮어쓸 예정")`,
  bestFor: [
    'EnterPlanMode → ExitPlanMode 루프를 플랜 요약으로 종결',
    'Destructive 작업 전 명시적 사람 승인을 위한 일시정지',
  ],
  avoidWhen: [
    'Plan mode가 아닐 때 — 호출은 no-op',
    '아직 실제 플랜이 없을 때 — read 도구로 더 많은 컨텍스트 수집부터',
  ],
  gotchas: [
    '거부된 플랜은 plan mode를 ACTIVE로 유지. 에이전트가 더 많은 정보 수집 후 수정된 플랜으로 ExitPlanMode 재호출 필요.',
    'Plan 인자는 사람에게 표시됨; 설명에 비밀 / api key 누출 주의.',
    '일부 호스트는 헤드리스 실행에서 plan-mode 종료를 auto-approve; 게이트에 의존하기 전 호스트 설정 확인.',
  ],
  examples: [
    {
      caption: '승인용으로 리팩토링 플랜 표면화',
      body: `{
  "plan": "1. src/auth.ts와 src/auth.test.ts Read\\n2. src/auth.ts Edit: verifyToken → validateToken 이름 변경(replace_all)\\n3. src/auth.test.ts Edit: 같은 이름 변경\\n4. pytest -k auth 실행\\n\\n건드리는 파일: src/auth.ts, src/auth.test.ts. 외부 시스템 없음."
}`,
      note: '호스트가 플랜 표시; 사용자 승인 또는 거부.',
    },
  ],
  relatedTools: ['EnterPlanMode'],
  relatedStages: ['4단계 (Permission guard)', '15단계 (HITL)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/plan_mode_tool.py:ExitPlanModeTool',
};

export const exitPlanModeToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
