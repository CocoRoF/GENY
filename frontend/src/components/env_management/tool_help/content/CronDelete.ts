/** Tool detail — CronDelete (executor / cron family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `CronDelete removes a registered cron entry by ID. The next scheduled trigger never fires; in-flight runs from previous triggers (if any) finish on their own — CronDelete doesn't kill them. The entry's metadata may persist briefly in audit logs but no further executions happen.

Use cases:
  - Cleanup at the end of a workflow ("the cron was for catching the rollout; rollout finished, delete it")
  - Replacing an old schedule with a new one (delete + CronCreate is the only mutation path)
  - Removing accidentally-created or test crons

Returns success even if the cron was already deleted (idempotent). The host's audit trail records the deletion event.

Important safety: cron entries persist across sessions, so a forgotten cron from a previous session is still running. Use CronList to inventory before assuming "no crons exist". An agent cleaning up its own work should always end with CronList → review → CronDelete on stragglers.`,
  bestFor: [
    'Replacing a cron with a different schedule (delete + create)',
    'Cleanup at workflow / experiment end',
    'Removing test or accidentally-created crons',
  ],
  avoidWhen: [
    'You want to PAUSE temporarily — there\'s no pause API; suspend by setting a far-future schedule, then restore',
    'You\'re killing an in-flight run — that\'s TaskStop on the run, not CronDelete on the schedule',
  ],
  gotchas: [
    'Idempotent — deleting a non-existent cron returns success. To verify deletion, follow with CronList.',
    'In-flight runs are not affected. The schedule stops; the current execution continues.',
    'Cross-session: a cron created by another agent / earlier session can be deleted by the current one IF permissions allow. Lock down in shared environments.',
  ],
  examples: [
    {
      caption: 'Remove the daily summary cron',
      body: `{
  "cron_id": "cron_a1b2c3"
}`,
      note: 'Schedule stops. Already-running invocations (if any) finish naturally.',
    },
  ],
  relatedTools: ['CronCreate', 'CronList', 'TaskStop'],
  relatedStages: [],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/cron_tools.py:CronDeleteTool',
};

const ko: ToolDetailContent = {
  body: `CronDelete는 등록된 cron 항목을 ID로 제거합니다. 다음 스케줄 트리거 절대 발화 안 함; 이전 트리거의 실행 중 runs(있으면) 스스로 끝남 — CronDelete가 죽이지 않음. 항목 메타데이터는 audit log에 잠시 영속할 수 있지만 추가 실행 없음.

사용 사례:
  - 워크플로 끝의 cleanup("cron이 rollout 캐치용이었음; rollout 끝남, 삭제")
  - 옛 스케줄을 새 스케줄로 교체(delete + CronCreate가 유일한 mutation 경로)
  - 실수로 생성됐거나 테스트 cron 제거

cron이 이미 삭제됐어도 성공 반환(idempotent). 호스트의 audit trail이 삭제 이벤트 기록.

중요한 안전성: cron 항목은 세션 가로질러 영속, 이전 세션의 잊혀진 cron이 여전히 실행 중. "cron 없음" 가정 전 inventory 위해 CronList 사용. 자신의 작업 cleanup하는 에이전트는 항상 CronList → 리뷰 → 잔여물에 CronDelete로 종료.`,
  bestFor: [
    'cron을 다른 스케줄로 교체(delete + create)',
    '워크플로 / 실험 끝의 cleanup',
    '테스트 또는 실수로 생성된 cron 제거',
  ],
  avoidWhen: [
    '일시 PAUSE 원함 — pause API 없음; 먼 미래 스케줄로 설정해 suspend, 나중에 복원',
    '실행 중 run 죽이기 — run에 TaskStop, 스케줄에 CronDelete 아님',
  ],
  gotchas: [
    'Idempotent — 존재하지 않는 cron 삭제도 성공 반환. 삭제 검증은 CronList 후속.',
    '실행 중 runs는 영향 안 받음. 스케줄은 멈춤; 현재 실행은 계속.',
    'Cross-session: 다른 에이전트 / 이전 세션이 생성한 cron도 permission 허용하면 현재 세션이 삭제 가능. 공유 환경은 잠그세요.',
  ],
  examples: [
    {
      caption: '일일 요약 cron 제거',
      body: `{
  "cron_id": "cron_a1b2c3"
}`,
      note: '스케줄 멈춤. 이미 실행 중인 invocation(있으면) 자연스럽게 끝남.',
    },
  ],
  relatedTools: ['CronCreate', 'CronList', 'TaskStop'],
  relatedStages: [],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/cron_tools.py:CronDeleteTool',
};

export const cronDeleteToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
