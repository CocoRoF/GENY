/** Tool detail — LSP (executor / dev family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `LSP exposes Language Server Protocol queries to the agent. Where Read / Grep operate on text, LSP works on the parsed program — definitions, references, types, hover docs, diagnostics. The executor manages the language server process; the agent just asks structured questions.

Common queries:
  - \`definition\`: where is this symbol defined? Returns file path + range.
  - \`references\`: which sites use this symbol? Returns a list of file:line:col.
  - \`hover\`: what's the type / docstring of the symbol at this position?
  - \`diagnostics\`: live errors / warnings from the language server (TypeScript errors, Python type errors, etc.)
  - \`symbols\`: outline of a file or workspace — classes, functions, methods.
  - \`rename\`: rename a symbol everywhere — semantic, not textual. Catches usages that text grep misses (different file, qualified by namespace, etc.)

The language server is auto-detected by the executor: TypeScript / JavaScript files use \`typescript-language-server\`, Python uses \`pylsp\`, etc. If no server is configured for the file's language, LSP returns an error — fall back to Grep.

LSP queries take effect against the current WorkspaceStack — so EnterWorktree's CWD swap is honoured. The language server starts lazily on the first query and persists across calls within a session.`,
  bestFor: [
    'Refactoring — `references` to find every call site, then `rename` to update them all',
    'Code exploration — `definition` to jump to where something lives, `hover` to see types',
    'Catching errors before run — `diagnostics` surfaces TypeScript / type errors as the agent edits',
    'Workspace orientation — `symbols` outline of a large module',
  ],
  avoidWhen: [
    'No language server installed for the file\'s language — falls back gracefully but adds latency',
    'You only need text search — Grep is faster and doesn\'t need a server',
    'The file isn\'t in a project the LSP can resolve — non-project scripts may not get full info',
  ],
  gotchas: [
    'First query in a session triggers LSP server boot — slow start, fast subsequent calls.',
    '`rename` is semantic, but only as good as the language server\'s analysis. Dynamic / runtime references are missed.',
    '`diagnostics` reflects the LSP server\'s opinion, not the build system\'s. The two can disagree on edge cases.',
    'Large workspaces can take a while to index. Initial `references` queries may return partial results.',
  ],
  examples: [
    {
      caption: 'Find all references to a function',
      body: `{
  "operation": "references",
  "file_path": "/repo/src/auth.ts",
  "line": 42,
  "character": 15
}`,
      note: 'Returns a list of file:line:col where the symbol at the given position is referenced.',
    },
  ],
  relatedTools: ['Read', 'Grep', 'Edit'],
  relatedStages: [],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/lsp_tool.py:LSPTool',
};

const ko: ToolDetailContent = {
  body: `LSP는 Language Server Protocol 쿼리를 에이전트에게 노출합니다. Read / Grep이 텍스트에 대해 동작하는 반면 LSP는 파싱된 프로그램에 대해 동작 — 정의, 참조, 타입, hover 문서, diagnostics. 실행기가 language server 프로세스 관리; 에이전트는 구조화 질문만.

흔한 쿼리:
  - \`definition\`: 이 심볼은 어디에 정의되었는가? 파일 경로 + 범위 반환.
  - \`references\`: 어떤 곳이 이 심볼을 사용하는가? file:line:col 리스트 반환.
  - \`hover\`: 이 위치 심볼의 타입 / docstring은?
  - \`diagnostics\`: language server의 라이브 에러 / 경고(TypeScript 에러, Python 타입 에러 등)
  - \`symbols\`: 파일이나 워크스페이스의 outline — 클래스, 함수, 메서드.
  - \`rename\`: 심볼을 모든 곳에서 이름 변경 — semantic, 텍스트 아님. 텍스트 grep이 놓치는 사용처(다른 파일, 네임스페이스로 qualified 등) 캐치.

Language server는 실행기가 자동 감지: TypeScript / JavaScript 파일은 \`typescript-language-server\`, Python은 \`pylsp\` 등 사용. 파일 언어에 server 설정 없으면 LSP가 에러 반환 — Grep으로 fallback.

LSP 쿼리는 현재 WorkspaceStack 기준으로 동작 — EnterWorktree의 CWD 스왑 반영. Language server는 첫 쿼리에 lazy하게 시작하고 세션 내 호출 간 영속.`,
  bestFor: [
    '리팩토링 — `references`로 모든 호출 사이트 찾고 `rename`으로 일괄 업데이트',
    '코드 탐색 — `definition`으로 정의 위치로 점프, `hover`로 타입 확인',
    '실행 전 에러 캐치 — 에이전트 편집 중 `diagnostics`가 TypeScript / 타입 에러 표면화',
    '워크스페이스 파악 — 큰 모듈의 `symbols` outline',
  ],
  avoidWhen: [
    '파일 언어에 language server 미설치 — 우아하게 fallback하지만 지연 추가',
    '텍스트 검색만 필요 — Grep이 더 빠르고 server 불필요',
    'LSP가 resolve할 수 없는 프로젝트의 파일 — non-project 스크립트는 풀 정보 못 얻을 수 있음',
  ],
  gotchas: [
    '세션의 첫 쿼리가 LSP server boot 트리거 — 느린 시작, 빠른 후속 호출.',
    '`rename`은 semantic이지만 language server 분석 만큼만 좋음. 동적 / 런타임 참조 놓침.',
    '`diagnostics`는 LSP server의 의견 반영, 빌드 시스템 아님. 둘이 edge case에서 다를 수 있음.',
    '큰 워크스페이스는 인덱싱에 시간 소요. 초기 `references` 쿼리는 부분 결과 반환할 수 있음.',
  ],
  examples: [
    {
      caption: '함수의 모든 참조 찾기',
      body: `{
  "operation": "references",
  "file_path": "/repo/src/auth.ts",
  "line": 42,
  "character": 15
}`,
      note: '주어진 위치 심볼이 참조된 file:line:col 리스트 반환.',
    },
  ],
  relatedTools: ['Read', 'Grep', 'Edit'],
  relatedStages: [],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/lsp_tool.py:LSPTool',
};

export const lspToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
