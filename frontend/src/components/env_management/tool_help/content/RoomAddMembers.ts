/** Tool detail — room_add_members (Geny / room family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `room_add_members invites additional sessions to an existing room. Pass the room ID and a list of session IDs; each invitee gets notified and gains read/write access to the room\'s message history (subject to host policy on backfill — some hosts show new members only future messages, others let them read history too).

Bulk-invite supported in a single call — no need to loop one-at-a-time. Partial-success semantics: bad session IDs fail individually; the rest succeed. Returns the full result list with per-invitee status.

Permissions: the calling session must be a member (or have moderation rights). Locked-down hosts may restrict invites to the room\'s creator. Cross-company invites usually require explicit admin permission.

Membership is durable — invitees stay until explicitly removed (room_remove_members in some host configs) or the room is archived.`,
  bestFor: [
    'Expanding a room\'s membership as new collaborators are needed',
    'Hot-adding an oncall agent to an incident room',
    'Bulk-inviting a freshly-spawned set of sub-agents to a coordination room',
  ],
  avoidWhen: [
    'You\'re creating a new room — room_create takes initial_members directly',
    'The session shouldn\'t be there long-term — DM instead',
    'You\'re unsure of session IDs — verify with session_list first',
  ],
  gotchas: [
    'Backfill policy is host-defined. Some hosts show new members the full message history; others only future messages.',
    'Partial-success: bad IDs fail per-entry but the call doesn\'t error overall. Inspect the result list.',
    'Notification spam: hosts may suppress repeated adds within a short window.',
    'No invite expiration. An invited session is a member until removed.',
  ],
  examples: [
    {
      caption: 'Add two more reviewers to an incident room',
      body: `{
  "room_id": "room_incident_42",
  "session_ids": ["sess_reviewer_43", "sess_oncall_44"]
}`,
      note: 'Returns per-invitee status. Both sessions become members and get notified.',
    },
  ],
  relatedTools: ['room_list', 'room_info', 'room_create', 'session_list'],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/built_in/geny_tools.py:RoomAddMembersTool',
};

const ko: ToolDetailContent = {
  body: `room_add_members는 기존 방에 추가 세션 초대. 방 ID와 세션 ID 리스트 전달; 각 초대자가 알림 받고 방 메시지 history에 read/write 액세스 획득(backfill 호스트 정책 따라 — 일부 호스트는 새 멤버에게 미래 메시지만 보여줌, 다른 호스트는 history도 읽게 함).

단일 호출에서 벌크 초대 지원 — 하나씩 루프 불필요. Partial-success 시맨틱: 나쁜 세션 ID는 개별 실패; 나머지 성공. invitee별 상태와 함께 풀 결과 리스트 반환.

권한: 호출 세션이 멤버여야(또는 moderation 권한 보유). 잠긴 호스트는 방 생성자에게만 초대 제한. Cross-company 초대는 보통 명시적 admin permission 필요.

멤버십은 durable — 명시적 제거(일부 호스트의 room_remove_members) 또는 방 archive 전까지 invitee 유지.`,
  bestFor: [
    '새 협업자 필요 시 방 멤버십 확장',
    'incident 방에 oncall 에이전트 hot-add',
    '갓 spawn된 sub-agent 세트를 조율 방에 벌크 초대',
  ],
  avoidWhen: [
    '새 방 생성 중 — room_create가 initial_members 직접 받음',
    '세션이 장기적으로 거기 있지 않아야 함 — DM',
    '세션 ID 불확실 — 먼저 session_list로 검증',
  ],
  gotchas: [
    'Backfill 정책은 호스트 정의. 일부 호스트는 새 멤버에게 풀 history 보여줌; 다른 호스트는 미래 메시지만.',
    'Partial-success: 나쁜 ID는 항목당 실패하지만 호출 자체는 에러 안 함. 결과 리스트 검사.',
    '알림 spam: 호스트가 짧은 window 내 반복 add 억제 가능.',
    '초대 만료 없음. 초대된 세션은 제거까지 멤버.',
  ],
  examples: [
    {
      caption: 'incident 방에 리뷰어 둘 추가',
      body: `{
  "room_id": "room_incident_42",
  "session_ids": ["sess_reviewer_43", "sess_oncall_44"]
}`,
      note: 'invitee별 상태 반환. 두 세션 모두 멤버 되고 알림 받음.',
    },
  ],
  relatedTools: ['room_list', 'room_info', 'room_create', 'session_list'],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/built_in/geny_tools.py:RoomAddMembersTool',
};

export const roomAddMembersToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
