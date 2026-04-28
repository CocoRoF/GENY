/** Tool detail — Bash (executor / shell family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `Bash spawns a shell subprocess and returns combined stdout/stderr. It is the single most-permissive tool in the catalog — anything the agent can express in shell, it can do here. Pair Bash with permissions and Stage 11 tool review for any environment that isn't tightly sandboxed.

The shell is the executor's host shell, initialised from the user's profile. Working directory comes from \`WorkspaceStack.current().cwd\`, so EnterWorktree's CWD swap is honoured. Environment variables inherit from the executor process plus anything set per-call via the manifest's tool_binding (rarely used).

Run modes:
  - Foreground (default): the agent waits for the command to finish, gets the full output (stdout + stderr) and exit code. The default timeout is 2 minutes; pass \`timeout_ms\` for slower commands. Long-running commands without explicit timeout will hang the loop until the default fires.
  - Background (\`run_in_background: true\`): the command spawns and returns immediately. Use Monitor to stream output, or rely on the command's own logfile.

Bash sometimes shells out to itself (e.g. \`bash -c\`); the path guard does NOT inspect command bodies. Permission rules with \`{tool: "Bash", match: {command: "rm -rf*"}}\` provide command-pattern allow/deny — that's the actual safety mechanism.

Output is truncated past a configurable threshold (typically ~10k chars) to protect the context window. The tool returns a marker indicating truncation; the agent can re-run with grep / head / tail to scope the output.`,
  bestFor: [
    'Build / test runners (`npm test`, `pytest -k foo`, `cargo build`)',
    'Git operations the executor doesn\'t expose as a dedicated tool',
    'One-off shell pipelines for data manipulation',
    'Spawning long-running services with `run_in_background: true` + Monitor',
  ],
  avoidWhen: [
    'You need to read a file — use Read (the path guard is stronger and the output is structured)',
    'You need to find a file — use Glob (faster, no shell quoting hazards)',
    'You need to grep — use Grep (parses ripgrep output directly)',
    'Anything user-facing without strict permissions and Stage 11 review enabled',
  ],
  gotchas: [
    'Combined stdout+stderr — the agent can\'t distinguish them. Redirect inside the command (`2>file.err`) when you need separation.',
    'Default 2-minute timeout. Long compiles / installs will hit it; pass `timeout_ms` explicitly.',
    'No interactive TTY. Commands that prompt (`sudo`, `git commit` without -m, etc.) hang and time out.',
    'The output is truncated past ~10k chars. Pipe through `head` / `tail` / `grep` if you only need part.',
    'Background mode does NOT capture exit code. Use Monitor or write to a logfile for status.',
  ],
  examples: [
    {
      caption: 'Run a focused test in foreground',
      body: `{
  "command": "pytest tests/unit/test_auth.py -k 'login' -v",
  "timeout_ms": 30000
}`,
      note: 'Returns combined stdout+stderr and exit code. 30s timeout overrides the default 2 min.',
    },
    {
      caption: 'Start a long-running watcher in background',
      body: `{
  "command": "npm run dev > /tmp/dev.log 2>&1",
  "run_in_background": true
}`,
      note: 'Returns immediately. Use Monitor on /tmp/dev.log to stream output.',
    },
  ],
  relatedTools: ['Read', 'Write', 'Glob', 'Grep', 'Monitor'],
  relatedStages: [
    'Stage 4 (Permission guard)',
    'Stage 11 (Tool review)',
    'Stage 10 (Tools)',
  ],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/bash_tool.py:BashTool',
};

const ko: ToolDetailContent = {
  body: `Bash는 셸 서브프로세스를 spawn하고 결합된 stdout/stderr를 반환합니다. 카탈로그에서 가장 권한이 큰 단일 도구 — 에이전트가 셸로 표현할 수 있는 모든 것을 여기서 할 수 있습니다. 엄격하게 샌드박싱되지 않은 환경에서는 permissions와 11단계 tool review와 함께 사용하세요.

셸은 실행기의 호스트 셸이며 사용자 프로파일에서 초기화됩니다. 작업 디렉토리는 \`WorkspaceStack.current().cwd\`에서 오므로 EnterWorktree의 CWD 스왑이 반영됩니다. 환경 변수는 실행기 프로세스에서 상속되고, 매니페스트의 tool_binding으로 호출별 설정 가능(드물게 사용).

실행 모드:
  - Foreground(기본): 에이전트가 명령 완료를 기다리고 전체 출력(stdout + stderr)과 종료 코드를 받음. 기본 timeout은 2분; 더 느린 명령은 \`timeout_ms\` 전달. 명시적 timeout 없는 장기 명령은 기본값 발동까지 루프 hang.
  - Background(\`run_in_background: true\`): 명령 spawn 후 즉시 반환. Monitor로 출력 스트리밍하거나 명령 자체의 로그파일 의존.

Bash가 자기 자신에게 shell out하기도 함(예: \`bash -c\`); path guard는 명령 본문을 검사하지 않습니다. \`{tool: "Bash", match: {command: "rm -rf*"}}\` 같은 permission 규칙이 명령 패턴 allow/deny 제공 — 실제 안전 메커니즘.

출력은 설정된 임계값(보통 ~10k 문자) 초과 시 잘립니다. 컨텍스트 창 보호 목적. 도구가 truncation 마커 반환; 에이전트는 grep / head / tail로 출력 범위를 좁혀 재실행 가능.`,
  bestFor: [
    '빌드 / 테스트 러너(`npm test`, `pytest -k foo`, `cargo build`)',
    '실행기가 전용 도구로 노출하지 않는 git 작업',
    '데이터 조작용 일회성 셸 파이프라인',
    '`run_in_background: true` + Monitor로 장기 서비스 spawn',
  ],
  avoidWhen: [
    '파일 읽기가 필요할 때 — Read 사용(path guard가 더 강하고 출력이 구조화됨)',
    '파일 찾기 — Glob 사용(더 빠르고 셸 quoting 위험 없음)',
    'grep 필요 — Grep 사용(ripgrep 출력 직접 파싱)',
    '엄격한 permissions와 11단계 review 없이 사용자 대면 환경',
  ],
  gotchas: [
    'stdout+stderr 결합 — 에이전트가 구분 불가. 분리 필요 시 명령 안에서 리다이렉트(`2>file.err`).',
    '기본 2분 timeout. 긴 컴파일 / 설치는 충돌; `timeout_ms` 명시 전달.',
    '인터랙티브 TTY 없음. 프롬프트하는 명령(`sudo`, `-m` 없는 `git commit` 등)은 hang하고 timeout.',
    '출력 ~10k 문자 초과 시 truncation. 일부만 필요하면 `head` / `tail` / `grep` 파이프.',
    'Background 모드는 종료 코드 캡처 안 함. 상태는 Monitor 또는 로그파일 작성으로.',
  ],
  examples: [
    {
      caption: 'Foreground에서 집중 테스트 실행',
      body: `{
  "command": "pytest tests/unit/test_auth.py -k 'login' -v",
  "timeout_ms": 30000
}`,
      note: '결합된 stdout+stderr와 종료 코드 반환. 30초 timeout이 기본 2분 override.',
    },
    {
      caption: '백그라운드에서 장기 watcher 시작',
      body: `{
  "command": "npm run dev > /tmp/dev.log 2>&1",
  "run_in_background": true
}`,
      note: '즉시 반환. /tmp/dev.log에 Monitor로 출력 스트리밍.',
    },
  ],
  relatedTools: ['Read', 'Write', 'Glob', 'Grep', 'Monitor'],
  relatedStages: [
    '4단계 (Permission guard)',
    '11단계 (Tool review)',
    '10단계 (Tools)',
  ],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/bash_tool.py:BashTool',
};

export const bashToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
