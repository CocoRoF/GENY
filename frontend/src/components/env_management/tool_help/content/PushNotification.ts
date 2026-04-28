/** Tool detail — PushNotification (executor / notification family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `PushNotification fires a fire-and-forget notification to the user without holding the agent's connection. The host implementation determines the actual delivery channel — desktop notification, mobile push, Slack message, etc.

Three typical use cases:
  1. **Background task done**: long-running work finishes when the user has switched contexts; the agent pings them.
  2. **Cron-triggered**: agent that runs on schedule needs to surface a result to the (possibly absent) user.
  3. **HITL nudge**: when AskUserQuestion or a Stage 15 HITL request is pending, a parallel push helps the user notice the agent is waiting.

The tool returns immediately with a delivery confirmation — it doesn't wait for the user to acknowledge the notification. If the user is offline, the host's notification backend handles persistence (or drops it; depends on implementation).

Notifications are NOT a substitute for SendUserFile (delivers a file artefact) or SendMessage (posts to a chat thread). PushNotification is purely a "ping" — short, transient, no payload other than the headline + body text.`,
  bestFor: [
    'Background tasks that finish when the user has switched contexts',
    'Cron-scheduled work surfacing results',
    'Nudging the user when HITL approval is overdue',
  ],
  avoidWhen: [
    'You need to deliver a file — use SendUserFile',
    'You need to post into a chat thread — use SendMessage',
    'The user is actively in the conversation — the response itself reaches them',
  ],
  gotchas: [
    'Fire-and-forget. The agent has no way to know the user actually saw the notification.',
    'Delivery channel is host-defined; rich-text formatting may or may not survive.',
    'Spammy if overused. Reserve for events the user genuinely cares about being interrupted for.',
  ],
  examples: [
    {
      caption: 'Notify user that a long task finished',
      body: `{
  "title": "Build complete",
  "body": "main: 0 errors, 2 warnings. Ready for review."
}`,
      note: 'Host renders title + body via its native notification channel.',
    },
  ],
  relatedTools: ['SendMessage', 'SendUserFile'],
  relatedStages: [],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/push_notification_tool.py:PushNotificationTool',
};

const ko: ToolDetailContent = {
  body: `PushNotification은 에이전트 연결을 잡지 않고 사용자에게 fire-and-forget 알림을 발송합니다. 실제 전달 채널은 호스트 구현이 결정 — 데스크톱 알림, 모바일 푸시, Slack 메시지 등.

전형적인 세 가지 사용 사례:
  1. **백그라운드 작업 완료**: 사용자가 컨텍스트를 전환한 후 장기 작업이 끝났을 때 에이전트가 ping.
  2. **Cron 트리거**: 스케줄로 실행되는 에이전트가 (없을 수도 있는) 사용자에게 결과 표면화.
  3. **HITL nudge**: AskUserQuestion이나 15단계 HITL 요청이 pending일 때 병렬 push가 사용자가 에이전트의 대기를 알아차리도록 도움.

도구는 delivery 확인과 함께 즉시 반환 — 사용자가 알림을 acknowledge할 때까지 기다리지 않음. 사용자가 오프라인이면 호스트의 notification 백엔드가 영속화(또는 drop; 구현에 따라).

알림은 SendUserFile(파일 아티팩트 전달)이나 SendMessage(채팅 스레드 포스팅)의 대체가 아닙니다. PushNotification은 순수 "ping" — 짧고 transient, headline + body 텍스트 외 페이로드 없음.`,
  bestFor: [
    '사용자가 컨텍스트를 전환한 후 끝나는 백그라운드 작업',
    'Cron 스케줄 작업의 결과 표면화',
    'HITL 승인이 지연될 때 사용자 nudge',
  ],
  avoidWhen: [
    '파일 전달 필요 — SendUserFile',
    '채팅 스레드 포스팅 — SendMessage',
    '사용자가 대화에 active한 상태 — 응답 자체가 도달',
  ],
  gotchas: [
    'Fire-and-forget. 에이전트가 사용자가 실제로 알림을 봤는지 알 방법 없음.',
    '전달 채널은 호스트 정의; rich-text 포맷팅이 살아남을 수도 안 살아남을 수도.',
    '남용 시 spammy. 사용자가 정말로 인터럽트되길 원하는 이벤트에 한정.',
  ],
  examples: [
    {
      caption: '장기 작업 완료를 사용자에게 알림',
      body: `{
  "title": "빌드 완료",
  "body": "main: 에러 0, 경고 2. 리뷰 준비됨."
}`,
      note: '호스트가 native notification 채널로 title + body 렌더.',
    },
  ],
  relatedTools: ['SendMessage', 'SendUserFile'],
  relatedStages: [],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/push_notification_tool.py:PushNotificationTool',
};

export const pushNotificationToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
