/** Tool detail — SendMessage (executor / messaging family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `SendMessage posts a message into the user's chat thread from a session that ISN'T the user's active conversation. Cron runs, sub-agents, and background tasks use it to surface messages into the user-facing chat without holding a connection.

Distinguished from the agent's normal response (which automatically appears in the conversation): SendMessage is for cross-session communication. The session calling it doesn't need to be the user's interactive session — it can be a cron-triggered run that emits "today's summary" into the user's chat.

The host routes the message based on \`recipient\` (typically a user ID or chat thread ID) and a \`source\` tag that identifies where the message came from (\`cron\`, \`agent:reviewer\`, etc.). The message appears in the user's chat with the source visible so they know it wasn't from a live conversation.

Different from PushNotification: PushNotification is a transient ping (desktop / mobile notification, not stored), SendMessage creates a persistent chat entry. Use Push for "look at this now", Send for "this becomes part of the conversation history".`,
  bestFor: [
    'Cron-scheduled agents posting summaries into user chats',
    'Sub-agents communicating back to the user when the parent isn\'t connected',
    'Background workers surfacing results as chat entries',
  ],
  avoidWhen: [
    'You\'re the active conversation — just respond normally',
    'You want a transient ping — PushNotification',
    'The recipient isn\'t known — you can\'t auto-discover user IDs from inside the agent',
  ],
  gotchas: [
    'Recipient is required and host-defined. Wrong format silently dead-letters in some host implementations.',
    'Persistent — message lands in chat history. Don\'t use for ephemeral status updates that would clutter the log.',
    'Source tag visible to the user. Useful for trust ("this came from the cron job, not me typing"); can be confusing if mislabelled.',
    'Some host configs rate-limit SendMessage to prevent runaway agents from spamming. Check your host\'s policy.',
  ],
  examples: [
    {
      caption: 'Post a daily summary from a cron run',
      body: `{
  "recipient": "user_42",
  "source": "cron:daily-summary",
  "body": "Today: 3 PRs merged, 2 reviews pending, 1 alert. Full report attached as report.md."
}`,
      note: 'Lands in user_42\'s chat thread tagged "cron:daily-summary".',
    },
  ],
  relatedTools: ['PushNotification', 'SendUserFile'],
  relatedStages: [],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/send_message_tool.py:SendMessageTool',
};

const ko: ToolDetailContent = {
  body: `SendMessage는 사용자의 active 대화가 아닌 세션에서 사용자의 채팅 스레드에 메시지를 포스팅합니다. Cron 실행, sub-agent, 백그라운드 task가 연결 잡지 않고 사용자 대면 채팅에 메시지 표면화하는 데 사용.

에이전트의 일반 응답(자동으로 대화에 등장)과 구별: SendMessage는 세션 간 통신용. 호출하는 세션이 사용자의 interactive 세션일 필요 없음 — cron 트리거 실행이 "오늘의 요약"을 사용자 채팅에 emit 가능.

호스트가 \`recipient\`(보통 사용자 ID 또는 채팅 스레드 ID)와 메시지가 온 곳을 식별하는 \`source\` 태그(\`cron\`, \`agent:reviewer\` 등)로 메시지 라우팅. 메시지가 사용자 채팅에 source 보이며 등장 — 라이브 대화에서 온 게 아닌 걸 알게 함.

PushNotification과 다름: PushNotification은 transient ping(데스크톱 / 모바일 알림, 저장 안 됨), SendMessage는 영속 채팅 항목 생성. "지금 봐"는 Push, "대화 history의 일부가 됨"은 Send.`,
  bestFor: [
    'Cron 스케줄된 에이전트가 사용자 채팅에 요약 포스팅',
    '부모가 연결 안 된 sub-agent가 사용자에게 다시 통신',
    '백그라운드 워커가 채팅 항목으로 결과 표면화',
  ],
  avoidWhen: [
    'Active 대화 중 — 일반 응답',
    'Transient ping 원함 — PushNotification',
    '수신자 모름 — 에이전트 안에서 사용자 ID 자동 발견 불가',
  ],
  gotchas: [
    'Recipient 필수이고 호스트 정의. 잘못된 형식은 일부 호스트 구현에서 silent dead-letter.',
    '영속 — 메시지가 채팅 history에 land. 로그를 어지럽힐 ephemeral status 업데이트에 사용 금지.',
    'Source 태그가 사용자에게 보임. 신뢰에 유용("내가 친 게 아니라 cron 잡에서 옴"); 잘못 라벨링하면 혼란.',
    '일부 호스트 설정은 runaway 에이전트의 spam 방지용으로 SendMessage rate-limit. 호스트 정책 확인.',
  ],
  examples: [
    {
      caption: 'Cron 실행에서 일일 요약 포스팅',
      body: `{
  "recipient": "user_42",
  "source": "cron:daily-summary",
  "body": "오늘: PR 3개 merge, 리뷰 2개 pending, 알림 1개. 전체 리포트는 report.md로 첨부."
}`,
      note: 'user_42의 채팅 스레드에 "cron:daily-summary" 태그와 함께 land.',
    },
  ],
  relatedTools: ['PushNotification', 'SendUserFile'],
  relatedStages: [],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/send_message_tool.py:SendMessageTool',
};

export const sendMessageToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
