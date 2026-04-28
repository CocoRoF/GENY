/** Tool detail — AskUserQuestion (executor / interaction family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `AskUserQuestion pauses the agent loop and surfaces a question to the user. The user's answer flows back as the tool result on the next turn — the agent then continues with that answer in context.

Different from Stage 15 HITL (which is approval-flow oriented):
  - HITL gates a specific action ("can I run this command?") with allow/deny semantics.
  - AskUserQuestion gathers free-form information ("which environment did you mean?") with arbitrary text answer.

Useful for ambiguity disambiguation and spec clarification. The agent should call this when:
  - The user's request has multiple plausible interpretations
  - A required parameter wasn't provided and can't be inferred
  - A choice has significant downstream implications and should be made by the human

Quality guidelines for the question:
  - Frame it as a single, answerable question
  - List the options when known ("Did you mean (a) the staging env, (b) the prod env, or (c) both?")
  - Don't pile multiple questions into one call — the user often answers only the first

In headless / non-interactive runs the call hangs until timeout. Configure your host's HITL requester to auto-answer with a default in those scenarios, or skip the tool entirely.`,
  bestFor: [
    'Ambiguity disambiguation ("which file did you mean?")',
    'Spec gathering when the user hasn\'t specified a key parameter',
    'High-stakes choices that benefit from explicit human selection',
  ],
  avoidWhen: [
    'Headless runs without a HITL responder — the loop deadlocks',
    'Questions the agent should answer itself by inspecting context',
    'Yes/no decisions about destructive actions — use HITL approval (Stage 15) for those',
  ],
  gotchas: [
    'Single question per call. Multi-question prompts get partial answers.',
    'No timeout default at the tool level — the host\'s HITL requester decides; check your config.',
    'Free-form text response. The agent should plan to interpret answers liberally (typos, partial answers).',
    'Sub-agents inherit the parent\'s HITL responder. AskUserQuestion from a sub-agent surfaces to the same human.',
  ],
  examples: [
    {
      caption: 'Disambiguate which file the user meant',
      body: `{
  "question": "I found two files matching 'config': /repo/.geny/config.json and /repo/src/config.ts. Which one did you want to edit?"
}`,
      note: 'Returns the user\'s text answer on the next turn.',
    },
  ],
  relatedTools: [],
  relatedStages: ['Stage 15 (HITL)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/ask_user_question_tool.py:AskUserQuestionTool',
};

const ko: ToolDetailContent = {
  body: `AskUserQuestion은 에이전트 루프를 일시정지하고 사용자에게 질문을 표면화합니다. 사용자의 답이 다음 턴의 tool result로 흘러 들어옴 — 에이전트가 그 답을 컨텍스트에 두고 계속.

15단계 HITL(승인 흐름 지향)과 다름:
  - HITL은 특정 액션을 allow/deny 시맨틱으로 게이트("이 명령 실행해도 됨?").
  - AskUserQuestion은 임의 텍스트 답으로 free-form 정보 수집("어떤 환경 말한 거야?").

모호성 해소와 스펙 명확화에 유용. 에이전트가 호출해야 할 때:
  - 사용자 요청에 여러 가능한 해석이 있을 때
  - 필수 파라미터가 제공되지 않았고 추론 불가할 때
  - 하류 영향이 큰 선택이라 사람이 결정해야 할 때

질문 품질 가이드라인:
  - 단일, 답할 수 있는 질문으로 frame
  - 알려진 경우 옵션 나열("(a) 스테이징, (b) 운영, (c) 둘 다 중 어느 것?")
  - 한 호출에 여러 질문 쌓지 마세요 — 사용자가 첫 번째만 답하는 경우 많음

헤드리스 / 비인터랙티브 실행에서는 timeout까지 호출이 hang. 그런 시나리오는 호스트의 HITL requester를 default 자동 응답으로 설정하거나 도구를 완전히 skip하세요.`,
  bestFor: [
    '모호성 해소("어떤 파일을 말한 거야?")',
    '사용자가 핵심 파라미터를 지정하지 않은 스펙 수집',
    '명시적 사람 선택이 도움 되는 고위험 선택',
  ],
  avoidWhen: [
    'HITL 응답자 없는 헤드리스 실행 — 루프 데드락',
    '에이전트가 컨텍스트 검사로 스스로 답할 수 있는 질문',
    'Destructive 액션에 대한 yes/no — 그건 HITL 승인(15단계)으로',
  ],
  gotchas: [
    '호출당 단일 질문. 멀티-질문 프롬프트는 부분 답 받음.',
    '도구 레벨 default timeout 없음 — 호스트의 HITL requester가 결정; 설정 확인.',
    '답은 free-form 텍스트. 에이전트가 답을 liberal하게 해석할 계획 필요(오타, 부분 답).',
    'Sub-agent는 부모의 HITL responder 상속. Sub-agent의 AskUserQuestion도 같은 사람에게 표면화.',
  ],
  examples: [
    {
      caption: '사용자가 의미한 파일 모호성 해소',
      body: `{
  "question": "'config' 매칭 파일이 두 개 있어요: /repo/.geny/config.json과 /repo/src/config.ts. 어느 걸 편집할까요?"
}`,
      note: '다음 턴에 사용자의 텍스트 답 반환.',
    },
  ],
  relatedTools: [],
  relatedStages: ['15단계 (HITL)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/ask_user_question_tool.py:AskUserQuestionTool',
};

export const askUserQuestionToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
