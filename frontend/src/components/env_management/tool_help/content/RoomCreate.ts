/** Tool detail — room_create (Geny / room family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `room_create opens a new chat room and invites initial members. Use it to start a focused group conversation around a project, decision, or topic — the room persists until explicitly closed and accumulates history that all members can read via read_room_messages.

Inputs:
  - \`name\`: human-readable room name (unique within the company)
  - \`topic\`: short description shown in the room directory
  - \`initial_members\`: list of session IDs to invite at creation
  - \`description\`: longer body / charter text (optional)

The creator is auto-added as a member. Returns the new room\'s ID.

Different from send_direct_message_internal (1:1 ephemeral conversation): rooms are multi-party and persistent. Use rooms for ongoing collaboration; DMs for individual coordination.`,
  bestFor: [
    'Starting a project / topic-scoped collaboration room',
    'Standing up an incident-response channel ("incident-2026-04-22")',
    'Inviting multiple specialists to align on a decision',
  ],
  avoidWhen: [
    '1:1 chat — send_direct_message_internal',
    'Topic already has a room — room_list first to avoid duplicates',
    'You\'re posting a one-shot announcement — direct messages or PushNotification fit better',
  ],
  gotchas: [
    'Names must be unique within the company. Duplicate names error.',
    'Initial members must be valid session IDs. Bad IDs cause partial-success: room created, some invites fail.',
    'Rooms accumulate history indefinitely until explicitly archived. Long-running rooms can have huge backlogs.',
    'The agent that creates a room owns it — host policy may grant moderation rights only to the creator.',
  ],
  examples: [
    {
      caption: 'Create an incident-response room',
      body: `{
  "name": "incident-2026-04-22-auth-outage",
  "topic": "Auth service degraded performance triage",
  "initial_members": ["sess_oncall_42", "sess_reviewer_42", "sess_user_42"]
}`,
      note: 'Returns room_id. Members get notified; creator is auto-added.',
    },
  ],
  relatedTools: ['room_list', 'room_info', 'room_add_members', 'send_room_message'],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/built_in/geny_tools.py:RoomCreateTool',
};

const ko: ToolDetailContent = {
  body: `room_create는 새 채팅방을 열고 초기 멤버를 초대합니다. 프로젝트, 결정, topic 중심의 집중된 그룹 대화 시작에 사용 — 방은 명시적 종료까지 영속하고, 모든 멤버가 read_room_messages로 읽을 수 있는 history 누적.

입력:
  - \`name\`: 사람이 읽을 수 있는 방 이름(회사 내 unique)
  - \`topic\`: 방 디렉토리에 표시되는 짧은 설명
  - \`initial_members\`: 생성 시 초대할 세션 ID 리스트
  - \`description\`: 더 긴 body / 헌장 텍스트(선택)

생성자가 자동 멤버 추가. 새 방의 ID 반환.

send_direct_message_internal(1:1 ephemeral 대화)과 다름: 방은 multi-party이고 영속. 진행 중 협업은 방, 개별 조율은 DM.`,
  bestFor: [
    '프로젝트 / topic 스코프 협업 방 시작',
    'incident-response 채널 셋업("incident-2026-04-22")',
    '결정에 align할 여러 전문가 초대',
  ],
  avoidWhen: [
    '1:1 채팅 — send_direct_message_internal',
    'Topic에 이미 방 있음 — 중복 회피 위해 먼저 room_list',
    '일회성 공지 포스팅 — DM 또는 PushNotification이 더 적합',
  ],
  gotchas: [
    '이름은 회사 내 unique. 중복 이름 에러.',
    'Initial members는 유효 세션 ID여야 함. 나쁜 ID는 partial-success: 방 생성, 일부 초대 실패.',
    '방은 명시적 archive 전까지 history 무기한 누적. 장기 방은 거대한 backlog 가능.',
    '방 생성 에이전트가 소유 — 호스트 정책이 생성자에게만 moderation 권한 부여 가능.',
  ],
  examples: [
    {
      caption: 'incident-response 방 생성',
      body: `{
  "name": "incident-2026-04-22-auth-outage",
  "topic": "Auth 서비스 성능 저하 triage",
  "initial_members": ["sess_oncall_42", "sess_reviewer_42", "sess_user_42"]
}`,
      note: 'room_id 반환. 멤버에게 알림; 생성자 자동 추가.',
    },
  ],
  relatedTools: ['room_list', 'room_info', 'room_add_members', 'send_room_message'],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/built_in/geny_tools.py:RoomCreateTool',
};

export const roomCreateToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
