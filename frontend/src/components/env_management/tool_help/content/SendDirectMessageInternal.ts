/** Tool detail — send_direct_message_internal (Geny / messaging family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `send_direct_message_internal sends a 1:1 DM to the agent\'s bound counterpart — a specific peer the current session is paired with for ongoing collaboration. Different from \`_external\` (which targets non-bound sessions): \`_internal\` is for the close partner relationship.

The "bound counterpart" model: many Geny deployments pair sessions in 1:1 working relationships (a worker + its reviewer, a planner + its executor). Internal DM is the primary communication channel for that pair — assumed-context, frequent, persistent.

Returns the message ID. Recipient gets the message via read_inbox; if they\'re online and listening, hosts often deliver it as a real-time event too.

When there\'s no bound counterpart (the session was created without a pair), the call errors. Use send_direct_message_external for ad-hoc 1:1 DMs to arbitrary sessions.`,
  bestFor: [
    'Coordinating with the bound peer (worker ↔ reviewer pair, etc.)',
    'Frequent, low-friction back-and-forth assumed-context messages',
    'Quick handoff signals (\"I\'m done with X — your turn\")',
  ],
  avoidWhen: [
    'Targeting a non-bound session — use send_direct_message_external',
    'Group conversation — send_room_message',
    'No counterpart configured — the call will error',
  ],
  gotchas: [
    'Errors when no counterpart bound. Verify with session_info if uncertain.',
    'Hosts often surface internal DMs more prominently than external ones (notification weight). Don\'t flood your counterpart.',
    'Persistent — message lives in chat history. Be deliberate about content.',
    'Counterpart relationship is fixed at session-create time on most hosts; you can\'t reassign mid-flight.',
  ],
  examples: [
    {
      caption: 'Hand off a task to the bound reviewer',
      body: `{
  "body": "Edit complete. PR #1234 ready for your review."
}`,
      note: 'Goes to the bound counterpart\'s inbox. They see it on next read_inbox or via real-time delivery.',
    },
  ],
  relatedTools: [
    'send_direct_message_external',
    'read_inbox',
    'session_info',
    'send_room_message',
  ],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/built_in/geny_tools.py:SendDirectMessageInternalTool',
};

const ko: ToolDetailContent = {
  body: `send_direct_message_internal은 에이전트의 바인딩된 카운터파트에게 1:1 DM 전송 — 현재 세션이 진행 중 협업을 위해 페어링된 특정 동료. \`_external\`(비바인딩 세션 타겟)과 다름: \`_internal\`은 가까운 파트너 관계용.

"바인딩된 카운터파트" 모델: 많은 Geny 배포가 세션을 1:1 작업 관계로 페어링(worker + reviewer, planner + executor). Internal DM이 그 페어의 주 통신 채널 — 가정된 컨텍스트, 잦음, 영속.

메시지 ID 반환. 수신자가 read_inbox로 메시지 받음; 온라인이고 listening이면 호스트가 실시간 이벤트로도 종종 전달.

바인딩된 카운터파트 없으면(세션이 페어 없이 생성됐으면) 호출 에러. 임의 세션에 ad-hoc 1:1 DM은 send_direct_message_external 사용.`,
  bestFor: [
    '바인딩된 동료와 조율(worker ↔ reviewer 페어 등)',
    '잦고 마찰 적은 가정된 컨텍스트 왔다갔다 메시지',
    '빠른 handoff 신호("X 끝남 — 당신 차례")',
  ],
  avoidWhen: [
    '비바인딩 세션 타겟 — send_direct_message_external',
    '그룹 대화 — send_room_message',
    '카운터파트 설정 안 됨 — 호출 에러',
  ],
  gotchas: [
    '카운터파트 바인딩 안 되면 에러. 불확실하면 session_info로 검증.',
    '호스트가 종종 external보다 internal DM을 더 prominently 표면화(알림 weight). 카운터파트 flood 금지.',
    '영속 — 메시지가 채팅 history에 살아남음. 콘텐츠 deliberate.',
    '대부분의 호스트에서 카운터파트 관계는 세션 생성 시점에 고정; 중간에 재할당 불가.',
  ],
  examples: [
    {
      caption: '바인딩된 리뷰어에게 task handoff',
      body: `{
  "body": "편집 완료. PR #1234 리뷰 준비됨."
}`,
      note: '바인딩된 카운터파트의 inbox로 감. 다음 read_inbox나 실시간 전달로 봄.',
    },
  ],
  relatedTools: [
    'send_direct_message_external',
    'read_inbox',
    'session_info',
    'send_room_message',
  ],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/built_in/geny_tools.py:SendDirectMessageInternalTool',
};

export const sendDirectMessageInternalToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
