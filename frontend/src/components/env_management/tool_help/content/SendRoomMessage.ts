/** Tool detail — send_room_message (Geny / messaging family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `send_room_message posts a message to a chat room. All current room members see the message in real time and have it in their history. Use it for group-visible communication — coordination across multiple sessions, broadcasts to a project room, decision announcements.

The message body is markdown-friendly — many Geny frontends render headings, lists, code blocks, and links. Mentioning a session by ID (\`@sess_xxx\`) typically triggers a per-recipient notification depending on host config.

Persisted to the room's history immediately. read_room_messages later in the same room sees the new entry. The agent gets back the message ID for any follow-up referencing.

Different from send_direct_message_internal: rooms are multi-party + persistent + observable; DMs are 1:1 + still persistent but conventionally private.`,
  bestFor: [
    'Coordinating across multiple agents who all live in the same room',
    'Posting a status update or decision summary the whole team should see',
    'Asking a room-wide question the right person can pick up',
  ],
  avoidWhen: [
    'You only need to talk to one person — send_direct_message_internal',
    'It\'s a notification (transient ping) — PushNotification',
    'You\'re posting to a chat thread the user controls — SendMessage',
  ],
  gotchas: [
    'Message goes to ALL members. Be mindful of noise; rooms can have many members.',
    'The sender must be a room member. Non-members get an authorisation error.',
    'Mentions trigger notifications — over-mentioning trains members to ignore them.',
    'Markdown rendering depends on host. Plain-text-readable formatting is safest.',
  ],
  examples: [
    {
      caption: 'Post a coordination update',
      body: `{
  "room_id": "room_incident_42",
  "body": "Mitigation deployed. @sess_oncall_42 — please verify metrics over the next 15min."
}`,
      note: 'Posted to all members; @sess_oncall_42 gets a notification.',
    },
  ],
  relatedTools: [
    'read_room_messages',
    'room_info',
    'send_direct_message_internal',
    'PushNotification',
  ],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/built_in/geny_tools.py:SendRoomMessageTool',
};

const ko: ToolDetailContent = {
  body: `send_room_message는 채팅방에 메시지 포스팅. 모든 현재 방 멤버가 실시간으로 메시지 보고 history에 가짐. 그룹 가시 통신에 사용 — 여러 세션 간 조율, 프로젝트 방 브로드캐스트, 결정 공지.

메시지 body는 마크다운 friendly — 많은 Geny frontend가 헤딩, 리스트, 코드 블록, 링크 렌더. 세션 ID로 멘션(\`@sess_xxx\`)은 호스트 설정에 따라 보통 수신자별 알림 트리거.

방 history에 즉시 영속. 같은 방의 후속 read_room_messages가 새 항목 봄. 에이전트는 follow-up 참조용 메시지 ID 받음.

send_direct_message_internal과 다름: 방은 multi-party + 영속 + 관찰 가능; DM은 1:1 + 여전히 영속이지만 관례적으로 private.`,
  bestFor: [
    '같은 방에 사는 여러 에이전트 간 조율',
    '팀 전체가 봐야 할 상태 업데이트나 결정 요약 포스팅',
    '적절한 사람이 pickup할 수 있는 방 전체 질문',
  ],
  avoidWhen: [
    '한 사람과만 얘기 — send_direct_message_internal',
    '알림(transient ping) — PushNotification',
    '사용자가 컨트롤하는 채팅 스레드 포스팅 — SendMessage',
  ],
  gotchas: [
    '메시지가 모든 멤버에게 감. 노이즈 신경 쓰기; 방에 많은 멤버 있을 수 있음.',
    '발신자가 방 멤버여야. 비멤버는 authorisation 에러.',
    '멘션이 알림 트리거 — 과도한 멘션은 멤버가 무시하도록 훈련.',
    '마크다운 렌더링은 호스트 의존. Plain-text 가독 포맷팅이 가장 안전.',
  ],
  examples: [
    {
      caption: '조율 업데이트 포스팅',
      body: `{
  "room_id": "room_incident_42",
  "body": "Mitigation 배포됨. @sess_oncall_42 — 다음 15분간 메트릭 검증 부탁."
}`,
      note: '모든 멤버에게 포스팅; @sess_oncall_42에게 알림.',
    },
  ],
  relatedTools: [
    'read_room_messages',
    'room_info',
    'send_direct_message_internal',
    'PushNotification',
  ],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/built_in/geny_tools.py:SendRoomMessageTool',
};

export const sendRoomMessageToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
