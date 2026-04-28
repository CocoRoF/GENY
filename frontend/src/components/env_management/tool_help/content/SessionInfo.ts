/** Tool detail — session_info (Geny / session family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `session_info returns the detailed profile of a specific team member by name or ID — model in use, system prompt summary, active tools, current status, last activity, role, and any host-defined metadata.

The deep-dive companion to session_list. Where session_list returns shallow directory metadata for many sessions, session_info gives the agent enough context to decide "should I delegate to them, message them, or pick someone else?"

Useful before send_direct_message_internal — knowing the recipient\'s role and current state shapes the message tone and expectations. Also useful for orchestrator agents that need to verify a sub-agent\'s configuration before fanning out work.

Returns an error when the target session doesn\'t exist or isn\'t visible (cross-company privacy in locked-down deployments).`,
  bestFor: [
    'Pre-flight before delegating to a specific session',
    'Verifying a peer\'s model / role / tool access before relying on them',
    'Building a "who\'s on duty?" view for the user',
  ],
  avoidWhen: [
    'You only need a list — session_list is cheaper',
    'You want chat history — read_inbox or read_room_messages',
    'You\'re creating a new session — session_create, not info on a non-existent one',
  ],
  gotchas: [
    'Returns the session\'s "static" config (model, role) plus a "dynamic" snapshot (status, last activity). Status is volatile.',
    'Cross-company sessions return errors in privacy-locked deployments.',
    'System prompt is summarised, not returned verbatim — full prompts can be sensitive.',
  ],
  examples: [
    {
      caption: 'Look up a reviewer agent\'s profile',
      body: `{
  "session_id": "sess_reviewer_42"
}`,
      note: 'Returns name, role, model, current status, active tools, last activity timestamp.',
    },
  ],
  relatedTools: ['session_list', 'session_create', 'send_direct_message_internal'],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/built_in/geny_tools.py:SessionInfoTool',
};

const ko: ToolDetailContent = {
  body: `session_info는 특정 팀원의 상세 프로필을 이름이나 ID로 반환 — 사용 모델, 시스템 프롬프트 요약, 활성 도구, 현재 상태, 마지막 활동, 역할, 호스트 정의 메타데이터.

session_list의 deep-dive 카운터파트. session_list가 많은 세션에 대한 shallow 디렉토리 메타데이터 반환하는 반면, session_info는 "그들에게 위임할까, 메시지 보낼까, 다른 사람 고를까?" 결정에 충분한 컨텍스트 제공.

send_direct_message_internal 전 유용 — 수신자의 역할과 현재 상태가 메시지 톤과 기대를 형성. 작업 fan-out 전 sub-agent 설정 검증 필요한 오케스트레이터 에이전트에도 유용.

타겟 세션이 존재 안 하거나 보이지 않을 때(잠긴 배포의 cross-company 프라이버시) 에러 반환.`,
  bestFor: [
    '특정 세션에 위임 전 사전 확인',
    '의존하기 전 동료의 모델 / 역할 / 도구 액세스 검증',
    '사용자용 "누가 근무 중?" 뷰 구축',
  ],
  avoidWhen: [
    '리스트만 필요 — session_list가 더 저렴',
    '채팅 history 원함 — read_inbox 또는 read_room_messages',
    '새 세션 생성 — session_create, 존재 안 하는 세션에 info 아님',
  ],
  gotchas: [
    '세션의 "정적" 설정(모델, 역할)과 "동적" 스냅샷(상태, 마지막 활동) 반환. 상태는 휘발성.',
    '프라이버시 잠긴 배포는 cross-company 세션에 에러 반환.',
    '시스템 프롬프트는 verbatim 아닌 요약 반환 — 풀 프롬프트는 민감할 수 있음.',
  ],
  examples: [
    {
      caption: '리뷰어 에이전트 프로필 lookup',
      body: `{
  "session_id": "sess_reviewer_42"
}`,
      note: '이름, 역할, 모델, 현재 상태, 활성 도구, 마지막 활동 타임스탬프 반환.',
    },
  ],
  relatedTools: ['session_list', 'session_create', 'send_direct_message_internal'],
  relatedStages: [],
  codeRef:
    'Geny / backend/tools/built_in/geny_tools.py:SessionInfoTool',
};

export const sessionInfoToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
