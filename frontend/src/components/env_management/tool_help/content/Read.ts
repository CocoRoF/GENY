/** Tool detail — Read (executor / filesystem family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `Read returns the contents of a file in cat -n format — every line is prefixed with its line number followed by a tab. The line-number prefix is metadata for the agent, not part of the file's actual contents; never include the prefix when later passing strings back to Edit.

Path resolution goes through the executor's path guard. The default working directory is the executor process CWD; when an EnterWorktree call is in flight, the WorkspaceStack swaps the CWD to the worktree branch and Read resolves relative paths against that. Absolute paths are recommended in all cases — they make the tool call self-describing and immune to CWD shifts.

By default Read returns up to 2000 lines. Pass offset (1-based line index to start from) and limit (number of lines) to scan a specific window of a large file. Reading past EOF returns whatever exists; reading offset > file_length returns empty content.

Binary files are detected by mime type and refused — except images, which return image content blocks the LLM can render directly. PDFs over 10 pages also require an explicit pages parameter so the model doesn't accidentally consume thousands of tokens on a long document.`,
  bestFor: [
    'Inspecting a known file by absolute path before editing it',
    'Reading specific line ranges of large logs / generated files',
    'Loading screenshots and small images (PNG / JPG) into the conversation',
    'Reading source files that the agent intends to modify with Edit',
  ],
  avoidWhen: [
    'You only need to know whether a path exists — use Glob with the exact pattern instead, faster and cheaper',
    'You want to find content across many files — use Grep, not Read in a loop',
    'You need raw bytes — Read returns text and rejects most binary formats',
  ],
  gotchas: [
    'The line-number prefix is `<n>\\t<content>`. When passing strings to Edit, strip the prefix or your match will fail.',
    'Image limit: a single Read call can spike the context window. For images, prefer one Read per image so the cache benefits compound.',
    'Symlinks are followed; the path guard rejects access outside the executor\'s allowed roots.',
    'PDFs over 10 pages WITHOUT a pages parameter return an error, not a partial read.',
  ],
  examples: [
    {
      caption: 'Read a slice of a large logfile',
      body: `{
  "file_path": "/var/log/agent/session-3.log",
  "offset": 1500,
  "limit": 200
}`,
      note: 'Returns lines 1500–1699 prefixed with their absolute line numbers.',
    },
  ],
  relatedTools: ['Write', 'Edit', 'Glob', 'Grep'],
  relatedStages: ['Stage 10 (Tools)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/read_tool.py:ReadTool',
};

const ko: ToolDetailContent = {
  body: `Read는 파일 내용을 cat -n 포맷으로 반환합니다 — 모든 줄에 줄 번호가 prefix로 붙고 탭이 따라옵니다. 줄 번호 prefix는 에이전트용 메타데이터일 뿐 파일의 실제 내용이 아니므로, 나중에 Edit에 문자열을 전달할 때는 prefix를 절대 포함하지 마세요.

경로 해석은 실행기의 path guard를 거칩니다. 기본 작업 디렉토리는 실행기 프로세스의 CWD; EnterWorktree 호출이 진행 중이면 WorkspaceStack이 CWD를 worktree 브랜치로 스왑하고 Read는 상대 경로를 그 기준으로 해석합니다. 모든 경우 절대 경로 사용을 권장 — 도구 호출이 self-describing해지고 CWD 변경에 영향받지 않습니다.

기본값으로 Read는 최대 2000줄을 반환합니다. offset(1-based 시작 줄)과 limit(줄 수)으로 큰 파일의 특정 구간만 스캔할 수 있습니다. EOF를 넘는 읽기는 존재하는 만큼 반환; offset이 파일 길이보다 크면 빈 내용 반환.

바이너리 파일은 mime type으로 감지해 거부합니다 — 이미지는 예외로, LLM이 직접 렌더할 수 있는 이미지 콘텐츠 블록으로 반환됩니다. 10페이지 초과 PDF는 명시적 pages 파라미터를 요구해 모델이 우연히 수천 토큰을 소비하지 않도록 합니다.`,
  bestFor: [
    '편집 전, 알고 있는 절대 경로의 파일 검사',
    '큰 로그 / 생성 파일의 특정 줄 범위 읽기',
    '스크린샷과 작은 이미지(PNG / JPG)를 대화에 로드',
    'Edit로 수정할 예정인 소스 파일 로딩',
  ],
  avoidWhen: [
    '경로 존재 여부만 알면 되는 경우 — 정확한 패턴으로 Glob 사용이 더 빠르고 저렴',
    '여러 파일에서 내용을 찾을 때 — 루프로 Read하지 말고 Grep 사용',
    '원시 바이트가 필요할 때 — Read는 텍스트를 반환하고 대부분의 바이너리를 거부',
  ],
  gotchas: [
    '줄 번호 prefix는 `<n>\\t<내용>` 형식. Edit에 문자열 전달 시 prefix 떼지 않으면 매칭 실패.',
    '이미지 한도: 단일 Read 호출이 컨텍스트 창을 크게 잡을 수 있음. 이미지마다 개별 Read 호출이 캐시 누적 면에서 유리.',
    'Symlink는 따라가며, path guard는 실행기 허용 루트 밖 접근을 거부.',
    '10페이지 초과 PDF에 pages 파라미터 없으면 부분 읽기가 아닌 에러 반환.',
  ],
  examples: [
    {
      caption: '큰 로그 파일의 일부 슬라이스 읽기',
      body: `{
  "file_path": "/var/log/agent/session-3.log",
  "offset": 1500,
  "limit": 200
}`,
      note: '1500–1699번 줄을 절대 줄 번호 prefix와 함께 반환.',
    },
  ],
  relatedTools: ['Write', 'Edit', 'Glob', 'Grep'],
  relatedStages: ['10단계 (Tools)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/read_tool.py:ReadTool',
};

export const readToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
