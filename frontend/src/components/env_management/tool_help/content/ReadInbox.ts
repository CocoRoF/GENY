/** Tool detail — read_inbox (Geny / messaging family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `read_inbox returns the agent\'s recent direct messages — both internal (from the bound counterpart) and external (from arbitrary peers). Use it to check who messaged the session while it was busy with other work.

Default returns the most recent N DMs newest-first. Filters:
  - \`unread_only\`: skip messages already read in earlier read_inbox calls (per-session read state)
  - \`since\`: scope by timestamp
  - \`from_session_id\`: only DMs from a specific peer
  - \`limit\`: cap (default 50)

Reading marks messages as read by default; pass \`mark_read: false\` to peek without consuming the unread flag — useful when an agent is sweeping for triage but doesn\'t want to "claim" the work yet.

Different from read_room_messages: inbox is private (just this session), rooms are shared. The agent should check both periodically when running long sessions where peers might message.`,
  bestFor: [
    'Periodic check-in during long-running tasks ("did anyone DM me?")',
    'Triage at the start of a session — read_inbox to catch up',
    'Filtering DMs from a specific peer',
  ],
  avoidWhen: [
    'You want room messages — read_room_messages',
    'You\'re looking for the user\'s chat (not DMs to this session) — that\'s the conversation context, not inbox',
  ],
  gotchas: [
    'Reading marks-as-read by default. Pass `mark_read: false` to peek silently.',
    'Read state is per-session — different sub-agents have separate read flags.',
    'Hosts vary on retention. Old inbox messages may age out.',
    'Pagination — large inboxes need explicit limit / since.',
  ],
  examples: [
    {
      caption: 'Check unread DMs',
      body: `{
  "unread_only": true,
  "limit": 20
}`,
      note: 'Returns up to 20 unread DMs newest-first; marks them read on return.',
    },
  ],
  relatedTools: [
    'send_direct_message_internal',
    'send_direct_message_external',
    'read_room_messages',
  ],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/built_in/geny_tools.py:ReadInboxTool',
};

const ko: ToolDetailContent = {
  body: `read_inbox는 에이전트의 최근 다이렉트 메시지 반환 — internal(바인딩된 카운터파트에서) 그리고 external(임의 동료에서) 모두. 다른 작업으로 바쁜 동안 누가 세션에 메시지했는지 확인할 때 사용.

기본은 최신 우선 가장 최근 N DM. 필터:
  - \`unread_only\`: 이전 read_inbox 호출에서 이미 읽은 메시지 skip(세션별 read 상태)
  - \`since\`: 타임스탬프 범위
  - \`from_session_id\`: 특정 동료의 DM만
  - \`limit\`: cap(기본 50)

읽기는 기본적으로 메시지를 읽음 표시; \`mark_read: false\` 전달로 unread 플래그 소비 없이 peek — 에이전트가 triage용 sweep하지만 아직 작업 "claim" 안 하려 할 때 유용.

read_room_messages와 다름: inbox는 private(이 세션만), 방은 공유. 동료가 메시지할 수 있는 장기 세션 실행 시 에이전트가 둘 다 주기적 확인해야.`,
  bestFor: [
    '장기 task 중 주기적 check-in("누가 DM 보냈나?")',
    '세션 시작 시 triage — read_inbox로 catch up',
    '특정 동료의 DM 필터링',
  ],
  avoidWhen: [
    '방 메시지 원함 — read_room_messages',
    '사용자 채팅(이 세션에 대한 DM 아님) — 그건 inbox 아닌 대화 컨텍스트',
  ],
  gotchas: [
    '읽기가 기본 mark-as-read. silent peek은 `mark_read: false`.',
    'Read 상태는 세션별 — 다른 sub-agent는 별도 read 플래그.',
    '호스트별 retention 다름. 옛 inbox 메시지는 age out 가능.',
    '페이지네이션 — 큰 inbox는 명시적 limit / since 필요.',
  ],
  examples: [
    {
      caption: '읽지 않은 DM 확인',
      body: `{
  "unread_only": true,
  "limit": 20
}`,
      note: '최신 우선 unread DM 최대 20개 반환; 반환 시 읽음 표시.',
    },
  ],
  relatedTools: [
    'send_direct_message_internal',
    'send_direct_message_external',
    'read_room_messages',
  ],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/built_in/geny_tools.py:ReadInboxTool',
};

export const readInboxToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
