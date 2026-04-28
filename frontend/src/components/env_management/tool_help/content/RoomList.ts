/** Tool detail — room_list (Geny / room family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `room_list enumerates active chat rooms. A room is a persistent group conversation — multiple sessions / users join, messages flow until the room closes, and history is queryable via read_room_messages.

Returned per room: ID, name, member count, last activity, topic / description. Use this to discover existing rooms before creating a new one (avoid duplicates), or to find the right venue for a topic-specific message.

Filters: \`active_only\` (hide rooms with no recent activity), \`name_pattern\` (glob), \`member_session_id\` (rooms a specific session belongs to). Default returns rooms the calling session is a member of; pass \`scope: "all"\` for the company-wide directory if permissions allow.`,
  bestFor: [
    'Discovering rooms before posting',
    'Auditing what rooms a session belongs to',
    'Pre-flight before room_create (does a similar room exist?)',
  ],
  avoidWhen: [
    'You want member info for a specific room — room_info',
    'You want chat history — read_room_messages',
    'You want session profiles — session_list',
  ],
  gotchas: [
    'Default scope is "rooms I belong to". For cross-company view, pass `scope: "all"` (permission required).',
    'Activity timestamps reflect the latest message; a room with no recent traffic may still be load-bearing.',
    'Pagination — large company histories accumulate many archived rooms.',
  ],
  examples: [
    {
      caption: 'List active rooms the current session belongs to',
      body: `{
  "active_only": true
}`,
      note: 'Returns metadata for rooms with recent activity that the calling session is a member of.',
    },
  ],
  relatedTools: ['room_info', 'room_create', 'send_room_message', 'read_room_messages'],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/built_in/geny_tools.py:RoomListTool',
};

const ko: ToolDetailContent = {
  body: `room_list는 활성 채팅방을 enumerate. 방은 영속 그룹 대화 — 여러 세션 / 사용자 합류, 방 닫힐 때까지 메시지 흐름, history는 read_room_messages로 쿼리 가능.

방별 반환: ID, 이름, 멤버 카운트, 마지막 활동, topic / 설명. 새 방 생성 전 기존 방 발견(중복 회피), 또는 topic-specific 메시지의 올바른 장소 찾기에 사용.

필터: \`active_only\`(최근 활동 없는 방 숨김), \`name_pattern\`(glob), \`member_session_id\`(특정 세션이 속한 방). 기본은 호출 세션이 멤버인 방 반환; permission 허용하면 회사 전체 디렉토리는 \`scope: "all"\` 전달.`,
  bestFor: [
    '포스팅 전 방 발견',
    '세션이 속한 방 audit',
    'room_create 전 사전 확인(유사 방 존재?)',
  ],
  avoidWhen: [
    '특정 방의 멤버 정보 — room_info',
    '채팅 history — read_room_messages',
    '세션 프로필 — session_list',
  ],
  gotchas: [
    '기본 스코프 "내가 속한 방". Cross-company 뷰는 `scope: "all"` 전달(permission 필요).',
    '활동 타임스탬프는 최신 메시지 반영; 최근 traffic 없는 방도 load-bearing일 수 있음.',
    '페이지네이션 — 큰 회사 history는 많은 archived 방 누적.',
  ],
  examples: [
    {
      caption: '현재 세션이 속한 활성 방 list',
      body: `{
  "active_only": true
}`,
      note: '호출 세션이 멤버이고 최근 활동 있는 방 메타데이터 반환.',
    },
  ],
  relatedTools: ['room_info', 'room_create', 'send_room_message', 'read_room_messages'],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/built_in/geny_tools.py:RoomListTool',
};

export const roomListToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
