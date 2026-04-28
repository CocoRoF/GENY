/** Tool detail — session_create (Geny / session family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `session_create hires a new team member — spawns a fresh agent session in the company. Different from the executor\'s Agent tool: Agent spawns a sub-agent inside the current session\'s scope (returns a result string, then dies); session_create creates a long-lived peer that joins the company and stays around for ongoing work.

The minimum input is \`session_name\`. Optional fields:
  - \`role\`: a host-defined role label (worker / reviewer / planner / researcher etc.) that drives default tool access and prompt
  - \`model\`: override the default model (e.g., spawn a heavy reasoner on Opus while the company default is Sonnet)
  - \`system_prompt\`: custom prompt for the new session
  - \`initial_message\`: kick the session off with a first task

Cost implications matter — long-lived sessions consume tokens until terminated. Don\'t spawn casually for tasks an Agent sub-agent could handle in one turn.

Returns the new session\'s ID. The caller can immediately send_direct_message_internal to start delegating, or just leave the session present for the user to interact with.`,
  bestFor: [
    'Hiring a long-lived peer (e.g., a "researcher" agent for the rest of the day)',
    'Specialised assistants the user can interact with directly',
    'Building a multi-agent company structure from scratch',
  ],
  avoidWhen: [
    'One-shot sub-tasks — use Agent (cheaper, scoped, auto-cleanup)',
    'You haven\'t verified the role / config — session_list / session_info first',
    'Cost-locked deployments — long-lived sessions accrue token use',
  ],
  gotchas: [
    'Long-lived: the session persists until explicitly terminated. Forgotten sessions accumulate cost.',
    'The new session\'s default tools / model come from the role descriptor; verify via session_info after creation if precise.',
    'No automatic deletion — clean up via host UI or admin tooling when done.',
    'Cross-company creation usually requires admin permission.',
  ],
  examples: [
    {
      caption: 'Hire a reviewer agent for the day',
      body: `{
  "session_name": "reviewer-2026-04-22",
  "role": "reviewer",
  "model": "claude-opus-4-7",
  "initial_message": "You\'ll be reviewing PRs for the next 8 hours. Watch for security issues, style violations, and missed test coverage."
}`,
      note: 'Returns session_id. Subsequent DMs / room invites can target this id.',
    },
  ],
  relatedTools: ['session_list', 'session_info', 'Agent', 'send_direct_message_internal'],
  relatedStages: ['Stage 12 (Agent / Orchestrator)'],
  codeRef:
    'Geny / backend/tools/built_in/geny_tools.py:SessionCreateTool',
};

const ko: ToolDetailContent = {
  body: `session_create는 새 팀원을 영입 — 회사에 새 에이전트 세션 spawn. 실행기의 Agent 도구와 다름: Agent는 현재 세션 스코프 안에서 sub-agent spawn(결과 문자열 반환 후 죽음); session_create는 회사에 합류하고 진행 중 작업을 위해 머무는 장기 peer 생성.

최소 입력은 \`session_name\`. 선택 필드:
  - \`role\`: 기본 도구 액세스와 프롬프트 주도하는 호스트 정의 역할 라벨(worker / reviewer / planner / researcher 등)
  - \`model\`: 기본 모델 override(예: 회사 기본은 Sonnet인데 무거운 reasoner는 Opus로 spawn)
  - \`system_prompt\`: 새 세션 커스텀 프롬프트
  - \`initial_message\`: 첫 task로 세션 시작

비용 영향 중요 — 장기 세션은 종료까지 토큰 소비. Agent sub-agent가 한 턴에 처리할 수 있는 작업에 쉽게 spawn 금지.

새 세션 ID 반환. 호출자가 즉시 send_direct_message_internal로 위임 시작하거나, 사용자가 상호작용하도록 세션 그냥 둘 수 있음.`,
  bestFor: [
    '장기 peer 영입(예: 하루 종일 "researcher" 에이전트)',
    '사용자가 직접 상호작용하는 specialised 어시스턴트',
    '처음부터 멀티 에이전트 회사 구조 구축',
  ],
  avoidWhen: [
    '일회성 sub-task — Agent 사용(더 저렴, 스코프, 자동 cleanup)',
    '역할 / 설정 검증 안 함 — 먼저 session_list / session_info',
    '비용 잠긴 배포 — 장기 세션은 토큰 사용 누적',
  ],
  gotchas: [
    '장기 — 세션은 명시적 종료까지 영속. 잊혀진 세션이 비용 누적.',
    '새 세션의 기본 도구 / 모델은 역할 descriptor에서 옴; 정확하면 생성 후 session_info로 검증.',
    '자동 삭제 없음 — 끝나면 호스트 UI 또는 admin tooling으로 cleanup.',
    'Cross-company 생성은 보통 admin permission 필요.',
  ],
  examples: [
    {
      caption: '하루용 리뷰어 에이전트 영입',
      body: `{
  "session_name": "reviewer-2026-04-22",
  "role": "reviewer",
  "model": "claude-opus-4-7",
  "initial_message": "다음 8시간 동안 PR 리뷰. 보안 이슈, 스타일 위반, 누락된 테스트 커버리지 watch."
}`,
      note: 'session_id 반환. 후속 DM / room 초대가 이 id 타겟 가능.',
    },
  ],
  relatedTools: ['session_list', 'session_info', 'Agent', 'send_direct_message_internal'],
  relatedStages: ['12단계 (Agent / 오케스트레이터)'],
  codeRef:
    'Geny / backend/tools/built_in/geny_tools.py:SessionCreateTool',
};

export const sessionCreateToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
