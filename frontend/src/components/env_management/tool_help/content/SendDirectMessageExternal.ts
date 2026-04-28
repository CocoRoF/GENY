/** Tool detail — send_direct_message_external (Geny / messaging family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `send_direct_message_external sends a 1:1 DM to a session that ISN\'T the agent\'s bound counterpart — an ad-hoc message to any peer in the company. Where \`_internal\` targets the fixed paired partner, \`_external\` is for cross-team / cross-pair communication.

Use cases:
  - Reaching another team\'s reviewer for a question outside your pair
  - Asking the user\'s personal assistant agent for a piece of context
  - Reporting to an admin / supervisor agent without involving your bound counterpart

The recipient must be a valid session ID and the calling session must have permission to message them (host-defined; some hosts allow company-wide DMs, others require explicit access lists).

Hosts may rate-limit external DMs more aggressively than internal ones to discourage spammy fan-out.`,
  bestFor: [
    'Cross-pair coordination ("I need input from a different reviewer")',
    'Reporting up the chain to a supervisor session',
    'One-shot questions to a specialist outside your usual partnership',
  ],
  avoidWhen: [
    'Recipient is your bound counterpart — send_direct_message_internal is the right channel',
    'Multiple recipients — use a room',
    'You don\'t know who to message — session_list / session_info first',
  ],
  gotchas: [
    'Permission errors are common in locked-down hosts. Discover access via session_list before assuming you can DM anyone.',
    'External DMs may have stricter rate limits. Bursty fan-out fails fast.',
    'Less prominent in some host UIs vs internal DMs. Recipients may notice slower.',
    'Etiquette: external DMs are interruptions. Respect the recipient\'s focus — terse, contextual, on-topic.',
  ],
  examples: [
    {
      caption: 'Ask a security specialist for a quick check',
      body: `{
  "session_id": "sess_security_reviewer_42",
  "body": "Quick question outside our usual pair — does this regex pattern leak any PII? \`^[a-z0-9._%+-]+@[a-z0-9.-]+\`"
}`,
      note: 'Goes to the named session\'s inbox. They reply at their pace.',
    },
  ],
  relatedTools: [
    'send_direct_message_internal',
    'read_inbox',
    'session_list',
    'session_info',
  ],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/built_in/geny_tools.py:SendDirectMessageExternalTool',
};

const ko: ToolDetailContent = {
  body: `send_direct_message_external은 에이전트의 바인딩된 카운터파트가 아닌 세션에 1:1 DM 전송 — 회사 내 임의 동료에게 ad-hoc 메시지. \`_internal\`이 고정 페어링 파트너 타겟인 반면 \`_external\`은 cross-team / cross-pair 통신.

사용 사례:
  - 페어 밖 질문을 위해 다른 팀의 리뷰어에게 도달
  - 컨텍스트 한 조각 위해 사용자의 개인 어시스턴트 에이전트에게 요청
  - 바인딩된 카운터파트 관여 없이 admin / supervisor 에이전트에게 보고

수신자가 유효 세션 ID여야 하고 호출 세션이 메시지 권한 보유해야(호스트 정의; 일부 호스트는 회사 전체 DM 허용, 다른 호스트는 명시적 액세스 리스트 요구).

호스트가 spammy fan-out 억제를 위해 internal보다 external DM을 더 공격적으로 rate-limit할 수 있음.`,
  bestFor: [
    'Cross-pair 조율("다른 리뷰어 input 필요")',
    'supervisor 세션에 chain 위로 보고',
    '평소 파트너십 밖 전문가에게 일회성 질문',
  ],
  avoidWhen: [
    '수신자가 바인딩된 카운터파트 — send_direct_message_internal이 올바른 채널',
    '여러 수신자 — 방 사용',
    '누구에게 메시지할지 모름 — 먼저 session_list / session_info',
  ],
  gotchas: [
    '잠긴 호스트에서 권한 에러 흔함. 누구에게나 DM 가정 전 session_list로 액세스 발견.',
    'External DM은 더 엄격한 rate limit 가능. Bursty fan-out 빠르게 실패.',
    '일부 호스트 UI에서 internal DM 대비 덜 prominent. 수신자가 더 늦게 알아챌 수 있음.',
    'Etiquette: External DM은 인터럽트. 수신자 집중 존중 — terse, contextual, 주제.',
  ],
  examples: [
    {
      caption: '보안 전문가에게 빠른 확인 요청',
      body: `{
  "session_id": "sess_security_reviewer_42",
  "body": "평소 페어 밖 빠른 질문 — 이 regex 패턴이 PII 누출하나? \`^[a-z0-9._%+-]+@[a-z0-9.-]+\`"
}`,
      note: '명시된 세션의 inbox로 감. 그들 페이스로 답.',
    },
  ],
  relatedTools: [
    'send_direct_message_internal',
    'read_inbox',
    'session_list',
    'session_info',
  ],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/built_in/geny_tools.py:SendDirectMessageExternalTool',
};

export const sendDirectMessageExternalToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
