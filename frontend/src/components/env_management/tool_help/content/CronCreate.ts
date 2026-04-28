/** Tool detail — CronCreate (executor / cron family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `CronCreate registers a recurring scheduled job. The executor's cron daemon (provided by the \`cron\` extra) interprets standard cron expressions and triggers the job at the specified cadence. The job body is typically "spawn an agent with this prompt" — a self-scheduling agent uses CronCreate to set up tomorrow's run before today's session ends.

Schedule formats:
  - Standard 5-field cron expression: \`* * * * *\` (minute hour day-of-month month day-of-week)
  - Extended 6-field with seconds: \`*/30 * * * * *\` (every 30 seconds)
  - Named shortcuts: \`@hourly\`, \`@daily\`, \`@weekly\`, \`@monthly\`

Job body is host-defined. Common shapes:
  - Agent dispatch: spawn a fresh AgentSession with a templated prompt
  - Bash command: same as TaskCreate-style execution but on a schedule
  - Skill invocation: execute a registered skill

Returns the cron entry's ID (\`cron_xyz\`). Use it later with CronDelete or CronList. Schedule changes require delete + create — there\'s no in-place mutation API to keep the contract simple.

Important: cron jobs persist across sessions (and often across executor restarts, depending on the persistence backend). The agent that creates a cron job is creating long-lived state. Permissions should constrain which environments can create crons.`,
  bestFor: [
    'Self-scheduling agents that need to "remind themselves" later',
    'Periodic monitoring / health-check loops',
    'Daily / weekly summary generation',
    'Long-tail maintenance tasks the user shouldn\'t have to think about',
  ],
  avoidWhen: [
    'You need a one-shot delayed call — TaskCreate with a sleep is simpler',
    'The schedule is highly dynamic — repeated CronCreate / Delete cycles are heavier than a single Task with internal scheduling',
    'You\'re in a permissioned env where cron creation should be human-only — let a human set it up via the cron admin UI',
  ],
  gotchas: [
    'Cron jobs persist beyond the session. Forgetting to CronDelete leaves background work running indefinitely.',
    'Schedule expressions use the executor\'s timezone, NOT the user\'s. Convert if the user\'s timezone matters.',
    'A misfired job (down at trigger time) is NOT retried by default — depends on the cron backend\'s catch-up policy.',
    'No transaction across cron entries. Creating multiple related crons can leave you with a half-state if one fails.',
  ],
  examples: [
    {
      caption: 'Schedule a daily summary at 9am',
      body: `{
  "schedule": "0 9 * * *",
  "name": "daily-summary",
  "body_type": "agent_dispatch",
  "body": {
    "prompt": "Generate a one-paragraph summary of today's GitHub activity and SendMessage it to user_42."
  }
}`,
      note: 'Returns cron_id. Daily 9am the executor spawns a fresh agent with the prompt.',
    },
  ],
  relatedTools: ['CronDelete', 'CronList', 'TaskCreate', 'SendMessage'],
  relatedStages: ['Stage 13 (Task registry)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/cron_tools.py:CronCreateTool',
};

const ko: ToolDetailContent = {
  body: `CronCreate는 주기적 스케줄 잡을 등록합니다. 실행기의 cron 데몬(\`cron\` extra가 제공)이 표준 cron 표현식 해석하고 지정된 cadence로 잡 트리거. 잡 본문은 보통 "이 prompt로 에이전트 spawn" — 셀프 스케줄링 에이전트가 오늘 세션 끝나기 전에 내일의 실행 셋업을 위해 CronCreate 사용.

스케줄 포맷:
  - 표준 5-field cron 표현식: \`* * * * *\`(분 시 day-of-month 월 day-of-week)
  - 초 포함 확장 6-field: \`*/30 * * * * *\`(30초마다)
  - 이름 shortcut: \`@hourly\`, \`@daily\`, \`@weekly\`, \`@monthly\`

잡 본문은 호스트 정의. 흔한 형태:
  - Agent dispatch: 템플릿 prompt로 새 AgentSession spawn
  - Bash 명령: TaskCreate 스타일 실행이지만 스케줄로
  - Skill 호출: 등록된 skill 실행

cron 항목 ID(\`cron_xyz\`) 반환. 나중에 CronDelete 또는 CronList로 사용. 스케줄 변경은 delete + create 필요 — 계약 단순 유지를 위해 in-place mutation API 없음.

중요: cron 잡은 세션을 가로질러 영속(영속 백엔드에 따라 종종 실행기 재시작도 가로지름). cron 잡 생성하는 에이전트가 장기 상태를 생성하는 것. Permissions가 어떤 환경이 cron 생성 가능한지 제약해야 함.`,
  bestFor: [
    '나중에 "스스로에게 상기"해야 하는 셀프 스케줄링 에이전트',
    '주기적 모니터링 / 헬스체크 루프',
    '일일 / 주간 요약 생성',
    '사용자가 생각 안 해도 되는 long-tail 유지보수 작업',
  ],
  avoidWhen: [
    '일회성 지연 호출 필요 — sleep 포함 TaskCreate가 더 간단',
    '스케줄이 매우 동적 — 반복 CronCreate / Delete 사이클이 내부 스케줄링 가진 단일 Task보다 무거움',
    'Cron 생성이 사람만 가능해야 하는 권한 환경 — 사람이 cron admin UI로 셋업',
  ],
  gotchas: [
    'Cron 잡은 세션 너머로 영속. CronDelete 잊으면 백그라운드 작업이 무기한 실행.',
    '스케줄 표현식은 사용자 timezone 아닌 실행기 timezone 사용. 사용자 timezone 중요하면 변환.',
    '미발화 잡(트리거 시점에 다운)은 기본적으로 retry 안 됨 — cron 백엔드의 catch-up 정책에 따라 다름.',
    'cron 항목 간 트랜잭션 없음. 관련된 여러 cron 생성 시 하나 실패하면 half-state 남을 수 있음.',
  ],
  examples: [
    {
      caption: '오전 9시 일일 요약 스케줄',
      body: `{
  "schedule": "0 9 * * *",
  "name": "daily-summary",
  "body_type": "agent_dispatch",
  "body": {
    "prompt": "오늘 GitHub 활동의 한 단락 요약을 생성하고 user_42에게 SendMessage하세요."
  }
}`,
      note: 'cron_id 반환. 매일 오전 9시에 실행기가 prompt로 새 에이전트 spawn.',
    },
  ],
  relatedTools: ['CronDelete', 'CronList', 'TaskCreate', 'SendMessage'],
  relatedStages: ['13단계 (Task registry)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/cron_tools.py:CronCreateTool',
};

export const cronCreateToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
