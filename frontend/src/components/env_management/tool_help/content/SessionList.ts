/** Tool detail — session_list (Geny / session family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `session_list enumerates all team members (agent sessions) in the current company. Each entry returns identity (name, role, model, status) — useful when an agent needs to discover who else is around before delegating, mentioning, or DMing.

The "company" model: Geny groups agent sessions into a workspace where they can see and message each other. session_list is the directory.

Returns metadata only — no chat history, no full configuration. Pair with session_info for a deep look at a specific peer.

Filters narrow the result: \`status\` (online / idle / offline), \`role\` (worker / reviewer / planner / etc.), \`name_pattern\`. Empty filters = full directory.`,
  bestFor: [
    'Discovering peers before delegating ("is there a reviewer agent active?")',
    'Surveying who\'s online before broadcasting',
    'Audit ("how many sessions are running, what roles?")',
  ],
  avoidWhen: [
    'You already know the target session — session_info or send_direct_message_internal directly',
    'You\'re looking for chat rooms — room_list',
  ],
  gotchas: [
    'Filtering by status returns the snapshot at call time. A session can flip online ↔ offline mid-task.',
    'Cross-company visibility depends on host config; locked-down deployments scope to "your own company" only.',
    'Pagination — large companies need explicit limit / offset.',
  ],
  examples: [
    {
      caption: 'List active reviewer agents',
      body: `{
  "status": "online",
  "role": "reviewer"
}`,
      note: 'Returns metadata for each online reviewer — name, model, last activity timestamp.',
    },
  ],
  relatedTools: ['session_info', 'session_create', 'send_direct_message_internal'],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/built_in/geny_tools.py:SessionListTool',
};

const ko: ToolDetailContent = {
  body: `session_list는 현재 회사의 모든 팀원(에이전트 세션) enumerate. 각 항목이 identity 반환(이름, 역할, 모델, 상태) — 에이전트가 위임, 멘션, DM 전 누가 주변에 있는지 발견 필요할 때 유용.

"회사" 모델: Geny가 에이전트 세션을 워크스페이스로 그룹핑 — 서로 보고 메시징 가능. session_list가 디렉토리.

메타데이터만 반환 — 채팅 history 없음, 풀 설정 없음. 특정 동료 깊이 보기는 session_info와 페어.

필터로 결과 좁히기: \`status\`(online / idle / offline), \`role\`(worker / reviewer / planner 등), \`name_pattern\`. 빈 필터 = 풀 디렉토리.`,
  bestFor: [
    '위임 전 동료 발견("리뷰어 에이전트 활성?")',
    '브로드캐스트 전 누가 온라인인지 survey',
    'Audit("몇 개 세션 실행 중, 어떤 역할?")',
  ],
  avoidWhen: [
    '타겟 세션 이미 아는 경우 — session_info 또는 send_direct_message_internal 직접',
    '채팅방 찾기 — room_list',
  ],
  gotchas: [
    '상태 필터링은 호출 시점 스냅샷 반환. 세션이 task 중간에 online ↔ offline flip 가능.',
    'Cross-company 가시성은 호스트 설정 의존; 잠긴 배포는 "자기 회사"로만 범위.',
    '페이지네이션 — 큰 회사는 명시적 limit / offset 필요.',
  ],
  examples: [
    {
      caption: '활성 리뷰어 에이전트 list',
      body: `{
  "status": "online",
  "role": "reviewer"
}`,
      note: '각 온라인 리뷰어의 메타데이터 반환 — 이름, 모델, 마지막 활동 타임스탬프.',
    },
  ],
  relatedTools: ['session_info', 'session_create', 'send_direct_message_internal'],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/built_in/geny_tools.py:SessionListTool',
};

export const sessionListToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
