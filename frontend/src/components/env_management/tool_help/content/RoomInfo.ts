/** Tool detail — room_info (Geny / room family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `room_info returns the deep view of a specific room — full member list, topic / description, creation timestamp, last activity, message count, and the room\'s settings (notification policy, retention, moderation rules where applicable).

Use it before posting to verify "is the right person in this room?" or before delegating "does this room have the context I assume?". Pair with read_room_messages when you need not just config but the recent chat history.

Returns an error when the room is closed / archived (some hosts retain only the metadata; others archive everything). Cross-company room visibility depends on permission policy.`,
  bestFor: [
    'Verifying room membership before posting / delegating',
    'Inspecting room settings (retention, notification) before changing them',
    'Audit ("who\'s in this room? when was the last message?")',
  ],
  avoidWhen: [
    'You only need the message log — read_room_messages',
    'You\'re about to create a room and want to check if it exists — room_list with name_pattern',
  ],
  gotchas: [
    'Member list reflects current state — members come and go.',
    'Some host configs return abridged member lists when membership is large (cap with summary count).',
    'Settings (retention, etc.) are host-defined; semantics may vary.',
  ],
  examples: [
    {
      caption: 'Inspect a specific room',
      body: `{
  "room_id": "room_incident_42"
}`,
      note: 'Returns members, topic, settings, last activity timestamp.',
    },
  ],
  relatedTools: ['room_list', 'room_create', 'room_add_members', 'read_room_messages'],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/built_in/geny_tools.py:RoomInfoTool',
};

const ko: ToolDetailContent = {
  body: `room_info는 특정 방의 deep 뷰 반환 — 풀 멤버 리스트, topic / 설명, 생성 타임스탬프, 마지막 활동, 메시지 카운트, 방 설정(알림 정책, retention, 적용 가능한 moderation 규칙).

포스팅 전 "올바른 사람이 이 방에 있나?" 검증, 또는 위임 전 "이 방이 내가 가정한 컨텍스트 가지나?" 검증에 사용. 설정뿐 아니라 최근 채팅 history도 필요하면 read_room_messages와 페어.

방이 닫힘 / archive됐을 때 에러 반환(일부 호스트는 메타데이터만 유지; 일부는 모든 것 archive). Cross-company 방 가시성은 permission 정책 의존.`,
  bestFor: [
    '포스팅 / 위임 전 방 멤버십 검증',
    '변경 전 방 설정(retention, 알림) 검사',
    'Audit("이 방에 누가? 마지막 메시지 언제?")',
  ],
  avoidWhen: [
    '메시지 로그만 필요 — read_room_messages',
    '방 생성하려고 존재 확인 — name_pattern과 함께 room_list',
  ],
  gotchas: [
    '멤버 리스트는 현재 상태 반영 — 멤버 들어오고 나감.',
    '일부 호스트 설정은 멤버십이 클 때 abridged 멤버 리스트 반환(cap과 summary count).',
    '설정(retention 등)은 호스트 정의; 시맨틱 다를 수 있음.',
  ],
  examples: [
    {
      caption: '특정 방 검사',
      body: `{
  "room_id": "room_incident_42"
}`,
      note: '멤버, topic, 설정, 마지막 활동 타임스탬프 반환.',
    },
  ],
  relatedTools: ['room_list', 'room_create', 'room_add_members', 'read_room_messages'],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/built_in/geny_tools.py:RoomInfoTool',
};

export const roomInfoToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
