/** Tool detail — REPL (executor / dev family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `REPL is a persistent Python shell session. Variables, imports, and function definitions survive across calls within the same session — the agent can iterate on data exploration, build up state, and inspect intermediate results without re-running setup code each turn.

Critical distinction from Bash:
  - Bash spawns a fresh subprocess per call. State doesn't survive.
  - REPL keeps the Python interpreter alive. State survives.

Output captures stdout, stderr, and the value of the last expression (if any). Exceptions are returned as tracebacks; the interpreter survives — subsequent calls work fine.

The session uses an isolated virtualenv managed by the executor, NOT the host's system Python. Common scientific stack (\`pandas\`, \`numpy\`, \`matplotlib\`, etc.) is pre-installed; for project-specific dependencies the agent installs them via Bash + pip into the REPL's venv.

Memory leaks accumulate. Long-running sessions with large dataframes can balloon. The agent should explicitly \`del\` large variables when done; restarting the REPL session loses everything but reclaims memory.`,
  bestFor: [
    'Iterative data exploration — load CSV, slice, plot, repeat',
    'Ad-hoc calculations the agent wants to verify before committing to code',
    'Multi-step pipelines where each step depends on the previous (no need to re-load)',
    'Quick experiments that\'d otherwise need a notebook',
  ],
  avoidWhen: [
    'You need to run a non-Python command — use Bash',
    'You want output saved to disk — REPL output is in the response, not a file',
    'You\'re running a one-off script — Bash + python -c is simpler',
  ],
  gotchas: [
    'State persists across calls. Forgetting variable names from earlier turns is a real failure mode.',
    'No interactive input. `input()` calls hang.',
    'Large dataframes accumulate. Restart the REPL when memory matters.',
    'Imports persist — useful, but a stale import from earlier in the session can confuse the agent.',
  ],
  examples: [
    {
      caption: 'Load a CSV and explore',
      body: `{
  "code": "import pandas as pd\\ndf = pd.read_csv('/data/sales.csv')\\nprint(df.shape)\\ndf.head()"
}`,
      note: 'Subsequent calls can reference `df` directly without re-loading.',
    },
  ],
  relatedTools: ['Bash', 'Read', 'NotebookEdit'],
  relatedStages: [],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/repl_tool.py:REPLTool',
};

const ko: ToolDetailContent = {
  body: `REPL은 영속 Python 셸 세션입니다. 변수, import, 함수 정의가 같은 세션 내 호출 간 살아남음 — 에이전트가 매 턴 setup 코드 재실행 없이 데이터 탐색을 반복하고, 상태를 쌓아가고, 중간 결과 검사 가능.

Bash와의 결정적 차이:
  - Bash는 호출당 새 서브프로세스 spawn. 상태 안 살아남음.
  - REPL은 Python 인터프리터 유지. 상태 살아남음.

출력은 stdout, stderr, 마지막 표현식 값(있으면) 캡처. 예외는 traceback으로 반환; 인터프리터는 살아남음 — 후속 호출 정상 작동.

세션은 호스트의 시스템 Python이 아닌 실행기가 관리하는 격리된 virtualenv 사용. 흔한 scientific stack(\`pandas\`, \`numpy\`, \`matplotlib\` 등) 사전 설치; 프로젝트별 의존성은 에이전트가 Bash + pip로 REPL의 venv에 설치.

메모리 누수 누적. 큰 dataframe과 함께 장기 실행 세션은 부풀어 오를 수 있음. 에이전트가 끝났을 때 큰 변수 명시적 \`del\`; REPL 세션 재시작은 모든 것 손실하지만 메모리 회수.`,
  bestFor: [
    '반복 데이터 탐색 — CSV 로드, 슬라이스, plot, 반복',
    '코드 커밋 전 검증할 ad-hoc 계산',
    '각 단계가 이전에 의존하는 멀티스텝 파이프라인(재로딩 불필요)',
    '노트북 필요할 빠른 실험',
  ],
  avoidWhen: [
    'Python 아닌 명령 실행 — Bash 사용',
    '출력을 디스크에 저장 — REPL 출력은 응답에, 파일 아님',
    '일회성 스크립트 실행 — Bash + python -c가 더 간단',
  ],
  gotchas: [
    '상태가 호출 간 영속. 이전 턴의 변수 이름 잊는 게 실제 실패 모드.',
    'Interactive input 없음. `input()` 호출 hang.',
    '큰 dataframe 누적. 메모리 중요하면 REPL 재시작.',
    'Import 영속 — 유용하지만 세션 초반의 stale import가 에이전트 혼란시킬 수 있음.',
  ],
  examples: [
    {
      caption: 'CSV 로드 후 탐색',
      body: `{
  "code": "import pandas as pd\\ndf = pd.read_csv('/data/sales.csv')\\nprint(df.shape)\\ndf.head()"
}`,
      note: '후속 호출이 재로딩 없이 `df` 직접 참조 가능.',
    },
  ],
  relatedTools: ['Bash', 'Read', 'NotebookEdit'],
  relatedStages: [],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/repl_tool.py:REPLTool',
};

export const replToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
