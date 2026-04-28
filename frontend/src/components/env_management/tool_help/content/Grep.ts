/** Tool detail — Grep (executor / filesystem family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `Grep is a thin wrapper around ripgrep (\`rg\`) — fast regex search across files. The wrapper handles ergonomics: glob filtering, file-type filtering, output mode selection, automatic respect for .gitignore.

Three output modes:
  - \`content\` (default): matched lines themselves, optionally with -n / -A / -B / -C context
  - \`files_with_matches\`: just the file paths that contain at least one match — fastest, useful for "show me all files that import X"
  - \`count\`: per-file match counts — useful for hot-spot analysis

Patterns are full regex by default. Multiline mode is opt-in (\`multiline: true\`) and lets a pattern span line breaks — handy for matching multi-line constructs like a JSX block or a multi-line comment.

\`type\` filters by language family using rg's built-in mappings (\`type: "ts"\` matches .ts and .tsx, \`type: "py"\` matches Python, etc.). \`glob\` is the escape hatch when the language family isn't enough — use a glob pattern like \`!**/*.test.ts\` to exclude tests.

Honors .gitignore by default. Pass \`-uu\` semantics through Bash if you really need to search inside ignored directories — Grep itself doesn't expose a "search everything" knob.`,
  bestFor: [
    'Finding all callers of a function across a codebase',
    'Locating where a specific string literal lives (config keys, error messages)',
    'Hot-spot analysis with `count` mode',
    'Exploring an unfamiliar repo — much faster than Read in a loop',
  ],
  avoidWhen: [
    'You need parsed AST-level info (use LSP for definitions / references)',
    'You\'re searching for a path-pattern, not file content (use Glob)',
    'You need to grep inside one specific file — Read with a small offset/limit window may be cheaper',
  ],
  gotchas: [
    'Default output is matched-lines, not files. For very common matches (e.g. `import`), use `files_with_matches` to keep the response bounded.',
    '.gitignore is honoured. If a build artefact matches but is git-ignored, you won\'t see it.',
    'Multiline mode is OFF by default — patterns with `\\n` won\'t match across lines unless you set `multiline: true`.',
    '`head_limit` caps the output rows — set it explicitly when scanning a large repo.',
  ],
  examples: [
    {
      caption: 'Find all files that import the auth module',
      body: `{
  "pattern": "from '@/lib/auth'",
  "type": "ts",
  "output_mode": "files_with_matches"
}`,
      note: 'Returns file paths only; ideal for fan-out analysis.',
    },
  ],
  relatedTools: ['Glob', 'Read', 'LSP', 'Bash'],
  relatedStages: ['Stage 10 (Tools)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/grep_tool.py:GrepTool',
};

const ko: ToolDetailContent = {
  body: `Grep은 ripgrep(\`rg\`)의 얇은 wrapper — 파일 전반의 빠른 정규식 검색. wrapper가 ergonomics 처리: glob 필터링, 파일 타입 필터링, 출력 모드 선택, .gitignore 자동 준수.

세 가지 출력 모드:
  - \`content\`(기본): 매칭된 줄 자체, 선택적으로 -n / -A / -B / -C 컨텍스트 포함
  - \`files_with_matches\`: 적어도 하나 매칭된 파일 경로만 — 가장 빠름, "X를 import하는 모든 파일 보여줘" 류에 유용
  - \`count\`: 파일별 매칭 카운트 — hot-spot 분석에 유용

패턴은 기본적으로 풀 정규식. Multiline 모드는 opt-in(\`multiline: true\`)으로 패턴이 줄바꿈을 가로지르게 함 — JSX 블록이나 멀티라인 주석 같은 멀티라인 구성 매칭에 유용.

\`type\`은 rg의 내장 매핑으로 언어 패밀리 필터(\`type: "ts"\`는 .ts와 .tsx 매칭, \`type: "py"\`는 Python 등). \`glob\`은 언어 패밀리로 부족할 때의 escape hatch — \`!**/*.test.ts\` 같은 glob으로 테스트 제외.

기본적으로 .gitignore 준수. 무시된 디렉토리 안 검색이 정말 필요하면 Bash로 \`-uu\` 시맨틱 통과 — Grep 자체는 "전부 검색" 노브 노출 안 함.`,
  bestFor: [
    '코드베이스 전반의 함수 caller 찾기',
    '특정 문자열 리터럴 위치 찾기(설정 키, 에러 메시지)',
    '`count` 모드로 hot-spot 분석',
    '낯선 repo 탐색 — 루프로 Read보다 훨씬 빠름',
  ],
  avoidWhen: [
    '파싱된 AST 레벨 정보 필요(정의/참조는 LSP 사용)',
    '파일 내용이 아닌 경로 패턴 검색(Glob 사용)',
    '특정 한 파일 안 grep — 작은 offset/limit 창의 Read가 더 저렴할 수도',
  ],
  gotchas: [
    '기본 출력은 매칭 줄, 파일 아님. 매우 흔한 매칭(예: `import`)은 `files_with_matches`로 응답 크기 제한.',
    '.gitignore 준수. 빌드 아티팩트가 매칭돼도 git-ignore면 안 보임.',
    'Multiline 모드 기본 OFF — `\\n` 포함 패턴은 `multiline: true` 없으면 줄 가로지르지 않음.',
    '`head_limit`이 출력 줄 cap — 큰 repo 스캔 시 명시적으로 설정.',
  ],
  examples: [
    {
      caption: 'auth 모듈을 import하는 모든 파일 찾기',
      body: `{
  "pattern": "from '@/lib/auth'",
  "type": "ts",
  "output_mode": "files_with_matches"
}`,
      note: '파일 경로만 반환; fan-out 분석에 이상적.',
    },
  ],
  relatedTools: ['Glob', 'Read', 'LSP', 'Bash'],
  relatedStages: ['10단계 (Tools)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/grep_tool.py:GrepTool',
};

export const grepToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
