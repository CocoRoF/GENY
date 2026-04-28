/** Tool detail — Glob (executor / filesystem family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `Glob expands a glob pattern against the filesystem and returns the matched paths sorted by modification time, newest first. The newest-first ordering is deliberate: when an agent is exploring a fresh worktree, recently-touched files are usually the relevant ones.

Patterns follow the standard syntax:
  - \`*\` matches anything except a path separator
  - \`**\` matches across path separators (recursive)
  - \`?\` matches exactly one character
  - \`[abc]\` matches one of a / b / c

Globs are evaluated relative to the path argument (default: CWD). The path guard rejects globs that would escape the executor's allowed roots — \`../**/*\` from within the working tree returns no results rather than reaching outside.

Glob does NOT read file contents. It's the file-discovery counterpart to Grep (which searches inside files). The two compose well: Glob to enumerate candidate paths, Grep to search inside the matches, Read to inspect the survivors.

Performance characteristics: Glob walks the filesystem under the path argument. Patterns rooted with \`**\` from a deep tree (e.g. \`**/*.tsx\` against a node_modules-heavy directory) can be slow. When you know the directory, narrow the path argument; when you don't, Glob is still much faster than spawning \`find\` via Bash.`,
  bestFor: [
    'Discovering all files matching a pattern (e.g. all `*.test.ts` files)',
    'Listing recently-modified files for a quick repo orientation',
    'Building a candidate list for a downstream Grep / Read sweep',
    'Checking whether a path matches a glob (returns empty if not)',
  ],
  avoidWhen: [
    'You need to search inside file content — use Grep, not Glob in a loop',
    'You want a single file by exact path — use Read directly',
    'Globs against very deep trees with no narrowing path argument — too slow, narrow first',
  ],
  gotchas: [
    'Sorted by mtime, not alphabetically — agents that expect lexical order will be surprised.',
    '`**/*` matches files and directories — filter by extension if you only want files.',
    'Hidden files (dotfiles) require an explicit pattern (e.g. `.*` / `**/.*.tsx`).',
    'Glob doesn\'t honour `.gitignore` — the executor\'s path guard is the only filter.',
  ],
  examples: [
    {
      caption: 'Find all React component files in a specific dir',
      body: `{
  "pattern": "src/components/**/*.tsx",
  "path": "/repo/frontend"
}`,
      note: 'Returns paths matching the glob, sorted by mtime (newest first).',
    },
  ],
  relatedTools: ['Grep', 'Read', 'Bash'],
  relatedStages: ['Stage 10 (Tools)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/glob_tool.py:GlobTool',
};

const ko: ToolDetailContent = {
  body: `Glob은 파일시스템에 glob 패턴을 expand해 매칭된 경로를 수정 시각 역순(최신 먼저)으로 반환합니다. 최신 우선 정렬은 의도적 — 에이전트가 새 worktree를 탐색할 때 최근에 만진 파일이 보통 관련 있는 파일이기 때문.

패턴은 표준 syntax 따름:
  - \`*\` — 경로 구분자 외 모든 것 매칭
  - \`**\` — 경로 구분자 가로지르는 매칭(재귀)
  - \`?\` — 정확히 한 문자
  - \`[abc]\` — a / b / c 중 하나

Glob은 path 인자(기본값: CWD) 기준으로 평가됩니다. path guard는 실행기 허용 루트를 벗어나는 glob을 거부 — 작업 트리 안에서의 \`../**/*\`은 외부 도달 대신 결과 없음으로 반환.

Glob은 파일 내용을 읽지 않습니다. Grep(파일 안 검색)의 파일 발견 카운터파트입니다. 둘은 잘 조합돼요: Glob으로 후보 경로 enumerate, Grep으로 매칭 안에서 검색, Read로 생존자 검사.

성능 특성: Glob은 path 인자 아래의 파일시스템을 walk합니다. 깊은 트리에서 \`**\`로 시작하는 패턴(예: node_modules 무거운 디렉토리에서 \`**/*.tsx\`)은 느릴 수 있음. 디렉토리를 안다면 path 인자로 좁히세요; 모르더라도 Bash로 \`find\` spawn하는 것보다 훨씬 빠릅니다.`,
  bestFor: [
    '패턴 매칭 모든 파일 발견(예: 모든 `*.test.ts` 파일)',
    '빠른 repo 파악을 위한 최근 수정 파일 나열',
    '하류 Grep / Read sweep용 후보 리스트 구축',
    '경로가 glob에 매칭되는지 확인(매칭 없으면 빈 결과)',
  ],
  avoidWhen: [
    '파일 내용 검색이 필요할 때 — 루프로 Glob하지 말고 Grep 사용',
    '정확한 경로의 단일 파일 — Read 직접 사용',
    '좁히는 path 인자 없이 매우 깊은 트리에 대한 Glob — 너무 느림, 먼저 좁히기',
  ],
  gotchas: [
    'mtime 정렬, 사전식 아님 — 사전 순 기대하는 에이전트는 놀랄 수 있음.',
    '`**/*`는 파일과 디렉토리 모두 매칭 — 파일만 원하면 확장자로 필터.',
    '히든 파일(dotfile)은 명시적 패턴 필요(예: `.*` / `**/.*.tsx`).',
    'Glob은 `.gitignore`를 honour하지 않음 — path guard가 유일한 필터.',
  ],
  examples: [
    {
      caption: '특정 디렉토리에서 모든 React 컴포넌트 파일 찾기',
      body: `{
  "pattern": "src/components/**/*.tsx",
  "path": "/repo/frontend"
}`,
      note: 'glob에 매칭되는 경로를 mtime 역순(최신 먼저)으로 반환.',
    },
  ],
  relatedTools: ['Grep', 'Read', 'Bash'],
  relatedStages: ['10단계 (Tools)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/glob_tool.py:GlobTool',
};

export const globToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
