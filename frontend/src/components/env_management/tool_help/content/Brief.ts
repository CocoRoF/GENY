/** Tool detail — Brief (executor / dev family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `Brief returns a compact summary of recent build / test / lint output. Where Bash dumps raw stdout (often thousands of lines), Brief parses the output of common tooling (TypeScript / ESLint / pytest / Jest / cargo / etc.) and surfaces just the actionable bits — error count, failure list, file:line:col references.

The agent uses Brief as the closing step of an iteration cycle: edit → test → Brief. The compact form fits in a fraction of the context Bash output would consume, so the agent can run many edit-test cycles without ballooning the conversation.

Two query modes:
  - \`last\`: parse the last Bash command's output (the executor remembers it for one call).
  - \`file\`: parse a logfile saved by an earlier background command (works with Bash run_in_background + Monitor).

Supported parsers detect the tool from output shape — TypeScript's \`error TS\` lines, pytest's \`FAILED\` summary, ESLint's JSON or stylish formatter, etc. Unrecognised output falls back to a generic "first 50 lines + last 50 lines" summary.

Brief is one of the most context-efficient tools in the catalog. For long-running CI-style work where the agent loops on test failures, using Brief instead of raw Bash output can extend session length by 5-10x.`,
  bestFor: [
    'Edit → test → Brief loops where the agent iterates on failures',
    'Long pytest / cargo / npm test runs where raw output would bloat context',
    'CI-style work — run, summarise, fix, repeat',
  ],
  avoidWhen: [
    'You actually need the full output (debugging a crash trace, etc.) — use Bash',
    'The tool isn\'t one of the supported parsers — fallback summary may miss the point',
  ],
  gotchas: [
    'The "last command" buffer is single-slot. A Bash call between the test and the Brief loses the test output.',
    'Some parsers depend on specific flags (e.g., pytest needs `--tb=short` for the cleanest summary).',
    'Brief discards stack traces by default. For full traces, the agent must Bash the test directly with stack-trace flags.',
    'Mixed-tool output (`npm test` running multiple test runners) may not parse cleanly — Brief picks one parser based on the first signal.',
  ],
  examples: [
    {
      caption: 'Summarise the last test run',
      body: `{
  "mode": "last"
}`,
      note: 'Parses the most recent Bash output. Returns failure count + each FAILED test\'s file:line:col + the diagnostic message.',
    },
  ],
  relatedTools: ['Bash', 'Monitor', 'LSP'],
  relatedStages: [],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/brief_tool.py:BriefTool',
};

const ko: ToolDetailContent = {
  body: `Brief는 최근 빌드 / 테스트 / lint 출력의 컴팩트 요약을 반환합니다. Bash가 raw stdout(종종 수천 줄)을 덤프하는 반면 Brief는 흔한 tooling(TypeScript / ESLint / pytest / Jest / cargo 등)의 출력을 파싱해 actionable 부분만 표면화 — 에러 카운트, 실패 리스트, file:line:col 참조.

에이전트는 Brief를 iteration cycle의 마무리 단계로 사용: edit → test → Brief. 컴팩트 형태가 Bash 출력이 소비할 컨텍스트의 일부에 들어가므로, 에이전트가 대화를 부풀리지 않고 많은 edit-test 사이클 가능.

두 query 모드:
  - \`last\`: 마지막 Bash 명령 출력 파싱(실행기가 한 번의 호출 동안 기억).
  - \`file\`: 이전 백그라운드 명령이 저장한 logfile 파싱(Bash run_in_background + Monitor와 함께 작동).

지원 파서는 출력 모양으로 도구 감지 — TypeScript의 \`error TS\` 줄, pytest의 \`FAILED\` 요약, ESLint의 JSON 또는 stylish formatter 등. 인식 안 된 출력은 일반 "처음 50줄 + 마지막 50줄" 요약으로 fallback.

Brief는 카탈로그에서 가장 컨텍스트 효율적인 도구 중 하나. 에이전트가 테스트 실패에 루프하는 장기 CI 스타일 작업에서 raw Bash 출력 대신 Brief 사용은 세션 길이를 5-10배 확장 가능.`,
  bestFor: [
    '에이전트가 실패에 반복 작업하는 edit → test → Brief 루프',
    'raw 출력이 컨텍스트 부풀릴 긴 pytest / cargo / npm test 실행',
    'CI 스타일 작업 — 실행, 요약, 수정, 반복',
  ],
  avoidWhen: [
    '풀 출력이 실제로 필요(crash trace 디버깅 등) — Bash 사용',
    '도구가 지원 파서 중 하나 아님 — fallback 요약이 핵심 놓칠 수 있음',
  ],
  gotchas: [
    '"last command" 버퍼는 single-slot. test와 Brief 사이의 Bash 호출이 test 출력 잃음.',
    '일부 파서는 특정 플래그 의존(예: pytest는 가장 깔끔한 요약에 `--tb=short` 필요).',
    'Brief는 기본적으로 stack trace 폐기. 풀 trace 필요 시 에이전트가 stack-trace 플래그와 함께 Bash로 테스트 직접 실행.',
    '혼합 도구 출력(`npm test`가 여러 test runner 실행)은 깔끔히 파싱 안 될 수 있음 — Brief가 첫 신호로 한 파서 선택.',
  ],
  examples: [
    {
      caption: '최근 테스트 실행 요약',
      body: `{
  "mode": "last"
}`,
      note: '가장 최근 Bash 출력 파싱. 실패 카운트 + 각 FAILED 테스트의 file:line:col + 진단 메시지 반환.',
    },
  ],
  relatedTools: ['Bash', 'Monitor', 'LSP'],
  relatedStages: [],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/brief_tool.py:BriefTool',
};

export const briefToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
