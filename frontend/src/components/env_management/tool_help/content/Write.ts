/** Tool detail — Write (executor / filesystem family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `Write creates a file at the given path or completely replaces an existing one. There is no append mode — every call overwrites. The agent must pass the full intended content; partial writes mean lost content.

Path semantics mirror Read: absolute paths recommended, the path guard rejects writes outside allowed roots, and EnterWorktree's CWD swap is honoured for relative paths. Parent directories are NOT auto-created — Write returns a clear error if a parent directory is missing, prompting the agent to create the directory first via Bash (\`mkdir -p\`).

For modifying an existing file, prefer Edit. Edit shows a precise diff in the audit log and only sends the change region; Write replaces the entire file even when only one line changed, which inflates the audit trail and increases the chance of accidentally clobbering parallel edits.

Write is destructive (capabilities.destructive = true). When permissions live in the project, a deny rule on Write \`{path: "src/**"}\` is a common safety net for environments where the agent shouldn't touch source code without going through Edit.`,
  bestFor: [
    'Creating brand-new files (configs, generated code, README, etc.)',
    'Overwriting a file the agent generated entirely from scratch this turn',
    'Snapshotting a fresh artifact (e.g. dumping a JSON report)',
  ],
  avoidWhen: [
    'Modifying an existing file — Edit is safer, cheaper, and keeps a tight diff',
    'Appending — Write doesn\'t append; you\'d need Read → concat → Write, which races',
    'Multi-step edits where you\'d Write the same file repeatedly — batch them or use Edit',
  ],
  gotchas: [
    'Parent directory must exist. Write will not create intermediate dirs.',
    'No backup. The previous content is gone the moment Write returns.',
    'Files with a trailing newline are preserved verbatim — if the language convention requires one, include it explicitly in the content.',
    'Write is in `destructive` capability — Stage 11 tool review can flag it for HITL approval.',
  ],
  examples: [
    {
      caption: 'Drop a generated config to disk',
      body: `{
  "file_path": "/repo/.geny/config.json",
  "content": "{\\n  \\"timeout_ms\\": 30000\\n}\\n"
}`,
      note: 'Creates or overwrites. Trailing newline preserved.',
    },
  ],
  relatedTools: ['Read', 'Edit', 'Bash'],
  relatedStages: ['Stage 10 (Tools)', 'Stage 11 (Tool review)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/write_tool.py:WriteTool',
};

const ko: ToolDetailContent = {
  body: `Write는 지정한 경로에 파일을 생성하거나 기존 파일을 완전히 교체합니다. append 모드는 없습니다 — 모든 호출이 덮어씁니다. 에이전트가 의도한 전체 내용을 전달해야 하며, 부분 쓰기는 콘텐츠 손실을 의미합니다.

경로 의미론은 Read와 동일: 절대 경로 권장, path guard가 허용 루트 밖 쓰기 거부, EnterWorktree의 CWD 스왑이 상대 경로에 반영. 부모 디렉토리는 자동 생성되지 않음 — 부모 디렉토리가 없으면 Write가 명확한 에러를 반환하여, 에이전트가 Bash(\`mkdir -p\`)로 먼저 디렉토리를 생성하도록 유도합니다.

기존 파일 수정에는 Edit를 우선 사용하세요. Edit는 audit log에 정밀한 diff를 보여주고 변경 영역만 전송; Write는 한 줄만 바뀌어도 전체 파일을 교체해 audit trail을 부풀리고 병렬 편집을 실수로 덮어쓸 가능성을 높입니다.

Write는 destructive(capabilities.destructive = true)입니다. 프로젝트 permissions에서 \`{path: "src/**"}\` Write deny 규칙은 에이전트가 Edit를 거치지 않고 소스 코드를 건드리지 못하게 하는 흔한 안전망입니다.`,
  bestFor: [
    '완전히 새 파일 생성(설정, 생성된 코드, README 등)',
    '이번 턴에 처음부터 생성한 파일 덮어쓰기',
    '신선한 아티팩트 스냅샷(예: JSON 리포트 덤프)',
  ],
  avoidWhen: [
    '기존 파일 수정 — Edit가 더 안전, 저렴, 깔끔한 diff 유지',
    '내용 추가 — Write는 append가 안 됨; Read → concat → Write 패턴은 race condition 위험',
    '같은 파일에 멀티스텝 편집을 반복할 때 — 배치하거나 Edit 사용',
  ],
  gotchas: [
    '부모 디렉토리가 반드시 존재해야 함. Write는 중간 디렉토리를 만들지 않음.',
    '백업 없음. Write가 반환되는 순간 이전 내용은 사라짐.',
    '후행 개행 그대로 보존 — 언어 컨벤션이 요구하면 content에 명시적으로 포함하세요.',
    'Write는 `destructive` capability — 11단계 tool review가 HITL 승인 플래그 가능.',
  ],
  examples: [
    {
      caption: '생성된 설정을 디스크에 저장',
      body: `{
  "file_path": "/repo/.geny/config.json",
  "content": "{\\n  \\"timeout_ms\\": 30000\\n}\\n"
}`,
      note: '생성 또는 덮어쓰기. 후행 개행 보존.',
    },
  ],
  relatedTools: ['Read', 'Edit', 'Bash'],
  relatedStages: ['10단계 (Tools)', '11단계 (Tool review)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/write_tool.py:WriteTool',
};

export const writeToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
