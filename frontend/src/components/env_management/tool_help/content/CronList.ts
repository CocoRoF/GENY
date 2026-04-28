/** Tool detail — CronList (executor / cron family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `CronList enumerates registered cron entries — the agent's view of "what background work is scheduled to run on this host". Returns metadata for each entry: ID, name, schedule expression, next-fire time, last-fire time + result, owner / source.

Filters scope the listing:
  - \`name_pattern\`: glob over entry names (\`backup-*\`)
  - \`owner\`: only crons created by a specific session / sub-agent (defaults to the calling session if locked-down; "all" otherwise)
  - \`active_only\`: hide disabled / paused entries

The next-fire time uses the executor's clock — useful for sanity-checking "did my cron actually take effect, and will it fire soon?". Last-fire info shows whether the most recent trigger succeeded — handy for debugging "did my daily-summary cron run yesterday?".

Cross-session visibility depends on the host's permission policy. Locked-down deployments restrict to crons the current agent owns; permissive ones let an admin agent see everything for housekeeping.

Use this BEFORE CronCreate to avoid duplicate schedules ("is there already a daily-summary cron?"). Use AFTER CronCreate to confirm the schedule materialised correctly.`,
  bestFor: [
    'Inventory before creating new crons (avoid duplicates)',
    'Audit "what\'s currently scheduled?"',
    'Debugging — checking last-fire result for a flaky cron',
    'Cleanup — list, decide, CronDelete the survivors',
  ],
  avoidWhen: [
    'You only want to confirm a specific cron exists — pass the ID via name_pattern instead of full enumeration',
    'You want execution-history detail beyond last-fire — query the host\'s audit / log endpoint',
  ],
  gotchas: [
    'Owner filtering depends on host permissions. Some hosts return only "your own" by default and require an explicit flag for global view.',
    'Last-fire info is best-effort — if the executor was down at the trigger time, "last fire" may be empty even though the schedule is active.',
    'Pagination for large catalogs (hundreds of crons). Default limit ~50, increase explicitly if needed.',
    'Time fields are ISO-8601 in the executor\'s timezone. Display to the user with explicit timezone if it matters.',
  ],
  examples: [
    {
      caption: 'List active crons created in this session',
      body: `{
  "active_only": true,
  "owner": "current"
}`,
      note: 'Returns metadata for each entry; agent decides whether any need delete / replace.',
    },
  ],
  relatedTools: ['CronCreate', 'CronDelete'],
  relatedStages: [],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/cron_tools.py:CronListTool',
};

const ko: ToolDetailContent = {
  body: `CronList는 등록된 cron 항목을 enumerate — 에이전트의 "이 호스트에 어떤 백그라운드 작업이 스케줄되어 있나?" 뷰. 각 항목의 메타데이터 반환: ID, 이름, 스케줄 표현식, 다음 발화 시각, 마지막 발화 시각 + 결과, 소유자 / 소스.

필터로 listing 범위:
  - \`name_pattern\`: 항목 이름 glob(\`backup-*\`)
  - \`owner\`: 특정 세션 / sub-agent가 생성한 cron만(잠긴 경우 호출 세션 기본; "all"은 그 외)
  - \`active_only\`: 비활성 / 일시정지 항목 숨김

다음 발화 시각은 실행기 시계 사용 — "내 cron이 실제로 적용됐고 곧 발화하나?" 검증에 유용. 마지막 발화 정보는 가장 최근 트리거 성공 여부 보여줌 — "어제 일일 요약 cron 실행됐나?" 디버깅에 편리.

Cross-session 가시성은 호스트 permission 정책에 의존. 잠긴 배포는 현재 에이전트 소유 cron으로 제한; 관대한 배포는 관리 에이전트가 housekeeping 위해 모두 보게 함.

CronCreate 전에 사용해 중복 스케줄 회피("이미 daily-summary cron 있나?"). CronCreate 후 사용해 스케줄이 올바르게 materialise됐는지 확인.`,
  bestFor: [
    '새 cron 생성 전 inventory(중복 회피)',
    '"현재 스케줄된 것?" audit',
    '디버깅 — flaky cron의 마지막 발화 결과 확인',
    'Cleanup — list, 결정, 잔여물에 CronDelete',
  ],
  avoidWhen: [
    '특정 cron 존재 확인만 원함 — 풀 enumeration 대신 name_pattern으로 ID 전달',
    '마지막 발화 너머 실행 history 디테일 — 호스트의 audit / log 엔드포인트 쿼리',
  ],
  gotchas: [
    '소유자 필터링은 호스트 permission 의존. 일부 호스트는 기본적으로 "자기 것"만 반환하고 글로벌 뷰는 명시적 플래그 필요.',
    '마지막 발화 정보는 best-effort — 트리거 시점에 실행기 다운이었으면 스케줄이 active여도 "last fire" 비어있을 수 있음.',
    '큰 카탈로그(수백 cron)는 페이지네이션. 기본 limit ~50, 필요 시 명시적으로 증가.',
    '시간 필드는 실행기 timezone의 ISO-8601. 중요하면 명시적 timezone과 함께 사용자에게 표시.',
  ],
  examples: [
    {
      caption: '이 세션에서 생성된 active cron list',
      body: `{
  "active_only": true,
  "owner": "current"
}`,
      note: '각 항목 메타데이터 반환; 에이전트가 delete / replace 필요한 것 결정.',
    },
  ],
  relatedTools: ['CronCreate', 'CronDelete'],
  relatedStages: [],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/cron_tools.py:CronListTool',
};

export const cronListToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
