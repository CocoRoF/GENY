/** Tool detail — read_room_messages (Geny / messaging family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `read_room_messages fetches the recent message history of a chat room. Returns chronologically-ordered messages with sender, body, timestamp, and any attachments. Default returns the most recent N messages; pass \`since\` to scope by timestamp or \`before\` for paging backwards.

Use this when joining an ongoing room to catch up, when looking for context that informed a recent decision, or when summarising what a team has been discussing.

Pagination model: pass \`limit\` (default 50) and \`before\` (timestamp or message ID) to walk back further. The full history may be huge — design queries to be focused.

Backfill availability depends on host. Some hosts give new members the full history; others give only future messages from join time. read_room_messages returns whatever the host exposes — empty results for messages prior to a member\'s join in restricted hosts.`,
  bestFor: [
    'Catching up on a room\'s recent activity',
    'Finding context for a decision made earlier in the room',
    'Summarising a discussion thread for the user',
  ],
  avoidWhen: [
    'You want to read DMs — read_inbox',
    'You only need metadata — room_info',
    'You\'re looking for one specific message — message search isn\'t a built-in; you\'ll have to scan',
  ],
  gotchas: [
    'Backfill policy varies by host. Restricted hosts return only post-join messages even with `before` set far back.',
    'Default limit is 50 — large rooms have far more. Page explicitly via `before`.',
    'Attachments referenced by ID, not inline. Follow up to fetch them.',
    'Timestamps are server-time, not the sender\'s local time.',
  ],
  examples: [
    {
      caption: 'Catch up on the last 30 messages',
      body: `{
  "room_id": "room_incident_42",
  "limit": 30
}`,
      note: 'Returns the most recent 30 messages newest-last for natural reading order.',
    },
  ],
  relatedTools: ['send_room_message', 'room_info', 'read_inbox'],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/built_in/geny_tools.py:ReadRoomMessagesTool',
};

const ko: ToolDetailContent = {
  body: `read_room_messages는 채팅방의 최근 메시지 history를 fetch. 발신자, body, 타임스탬프, 첨부와 함께 시간 순서 정렬된 메시지 반환. 기본은 가장 최근 N개 메시지; 타임스탬프 범위는 \`since\`, 역방향 페이징은 \`before\` 전달.

진행 중 방 join 시 catch up할 때, 최근 결정에 영향 준 컨텍스트 찾을 때, 팀이 논의한 것 요약할 때 사용.

페이지네이션 모델: \`limit\`(기본 50)과 \`before\`(타임스탬프 또는 메시지 ID) 전달해 뒤로 walk. 풀 history 거대할 수 있음 — focused 쿼리 설계.

Backfill 가용성은 호스트 의존. 일부 호스트는 새 멤버에게 풀 history 줌; 다른 호스트는 join 시점 이후 미래 메시지만. read_room_messages는 호스트가 노출하는 것 반환 — 제한된 호스트에서 멤버 join 이전 메시지는 빈 결과.`,
  bestFor: [
    '방의 최근 활동 catch up',
    '방에서 일찍 만든 결정의 컨텍스트 찾기',
    '사용자용 논의 스레드 요약',
  ],
  avoidWhen: [
    'DM 읽기 — read_inbox',
    '메타데이터만 필요 — room_info',
    '특정 메시지 하나 찾기 — 메시지 검색은 빌트인 아님; 스캔 필요',
  ],
  gotchas: [
    'Backfill 정책 호스트별. 제한된 호스트는 `before`를 멀리 설정해도 join 후 메시지만 반환.',
    '기본 limit 50 — 큰 방은 훨씬 많음. `before`로 명시적 페이징.',
    '첨부는 ID로 참조, 인라인 아님. fetch는 follow-up.',
    '타임스탬프는 서버 시간, 발신자 로컬 시간 아님.',
  ],
  examples: [
    {
      caption: '최근 30개 메시지 catch up',
      body: `{
  "room_id": "room_incident_42",
  "limit": 30
}`,
      note: '자연스러운 읽기 순서를 위해 최신 last로 가장 최근 30개 메시지 반환.',
    },
  ],
  relatedTools: ['send_room_message', 'room_info', 'read_inbox'],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/built_in/geny_tools.py:ReadRoomMessagesTool',
};

export const readRoomMessagesToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
