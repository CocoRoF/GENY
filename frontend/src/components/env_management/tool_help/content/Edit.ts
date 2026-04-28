/** Tool detail — Edit (executor / filesystem family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `Edit performs an exact-string find-and-replace on a file. Two strict invariants:

  1. The agent MUST have called Read on the file at least once in the conversation. The executor remembers reads per-file and rejects Edit on a file the agent has never read — this prevents blind edits based on the model's stale memory.

  2. \`old_string\` must be unique within the file. If the substring appears more than once Edit fails (you'll see a "match not unique" error). Either pass a longer surrounding context to disambiguate, or set \`replace_all: true\` to substitute every occurrence.

When the file already has the exact \`new_string\` content (i.e. the change is a no-op), Edit returns success without writing — useful for idempotent flows where the agent retries.

Edit preserves indentation verbatim. Mixing tabs and spaces in \`old_string\` will cause the match to miss against a file that uses the other; copy the indentation from a fresh Read result before submitting.

Compared to Write, Edit:
  - Sends only the diff payload (cheaper in audit logs and quotas)
  - Surfaces a precise change region for permission rules to match against
  - Leaves the rest of the file alone, preventing accidental clobbers from parallel edits`,
  bestFor: [
    'Renaming a symbol across one file (with replace_all: true)',
    'Swapping a configuration value or import path',
    'Applying a precise patch the agent already verified by reading the file',
    'Idempotent retries — re-applying the same Edit is a no-op once the change is in place',
  ],
  avoidWhen: [
    'Creating a new file — use Write',
    'You haven\'t Read the file in this conversation — Edit will refuse',
    'The change spans multiple non-contiguous regions — split into multiple Edit calls',
  ],
  gotchas: [
    'Indentation matters byte-for-byte. Mixed tabs/spaces between read and write fail silently.',
    '`old_string` not unique → Edit errors. Add more surrounding context, or use replace_all.',
    'When reading from cat -n output, strip the `<n>\\t` prefix from each line before passing to Edit.',
    'Line endings (CRLF vs LF) must match the file\'s convention.',
  ],
  examples: [
    {
      caption: 'Rename a symbol throughout a single file',
      body: `{
  "file_path": "/repo/src/auth.ts",
  "old_string": "verifyToken",
  "new_string": "validateToken",
  "replace_all": true
}`,
      note: 'Every occurrence of `verifyToken` becomes `validateToken`.',
    },
  ],
  relatedTools: ['Read', 'Write', 'Grep'],
  relatedStages: ['Stage 10 (Tools)', 'Stage 11 (Tool review)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/edit_tool.py:EditTool',
};

const ko: ToolDetailContent = {
  body: `Edit는 파일에서 정확한 문자열 find-and-replace를 수행합니다. 두 가지 엄격한 invariant:

  1. 에이전트가 대화 중 해당 파일에 대해 Read를 적어도 한 번 호출했어야 합니다. 실행기가 파일별 읽기 이력을 기억하며, 읽은 적 없는 파일에 대한 Edit는 거부 — 모델의 stale 메모리에 기반한 blind edit을 방지합니다.

  2. \`old_string\`은 파일 내에서 unique해야 합니다. 부분 문자열이 두 번 이상 등장하면 Edit 실패("match not unique" 에러). 주변 컨텍스트를 더 길게 전달해 disambiguate하거나, \`replace_all: true\`로 모든 occurrence 치환.

파일에 이미 정확히 \`new_string\` 내용이 있으면(즉 변경이 no-op이면), Edit는 쓰지 않고 성공 반환 — 에이전트가 재시도하는 idempotent flow에 유용.

Edit는 들여쓰기를 byte 단위로 보존합니다. \`old_string\`에서 탭/공백을 혼용하면 다른 쪽을 쓰는 파일에 매칭 실패; 신선한 Read 결과에서 들여쓰기를 복사해 전달하세요.

Write 대비 Edit는:
  - diff 페이로드만 전송(audit log와 quota 면에서 저렴)
  - permission 규칙이 매칭할 정밀한 변경 영역 노출
  - 파일의 나머지를 건드리지 않아 병렬 편집의 실수 덮어쓰기 방지`,
  bestFor: [
    '단일 파일의 심볼 이름 변경(replace_all: true와 함께)',
    '설정 값이나 import 경로 교체',
    '에이전트가 파일을 읽고 검증한 정밀 패치 적용',
    'Idempotent 재시도 — 같은 Edit를 다시 적용해도 변경 후엔 no-op',
  ],
  avoidWhen: [
    '새 파일 생성 — Write 사용',
    '이번 대화에서 파일을 Read하지 않은 경우 — Edit가 거부',
    '비연속 여러 영역에 걸친 변경 — 여러 Edit 호출로 분할',
  ],
  gotchas: [
    '들여쓰기가 byte-for-byte 일치해야 함. 탭/공백 혼용 시 silent하게 실패.',
    '`old_string`이 unique하지 않으면 Edit 에러. 컨텍스트 더 추가하거나 replace_all 사용.',
    'cat -n 출력에서 읽을 때 각 줄의 `<n>\\t` prefix를 떼고 Edit에 전달.',
    '줄 끝(CRLF vs LF)이 파일 컨벤션과 일치해야 함.',
  ],
  examples: [
    {
      caption: '단일 파일에서 심볼 이름 일괄 변경',
      body: `{
  "file_path": "/repo/src/auth.ts",
  "old_string": "verifyToken",
  "new_string": "validateToken",
  "replace_all": true
}`,
      note: '`verifyToken`의 모든 occurrence가 `validateToken`으로 변경.',
    },
  ],
  relatedTools: ['Read', 'Write', 'Grep'],
  relatedStages: ['10단계 (Tools)', '11단계 (Tool review)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/edit_tool.py:EditTool',
};

export const editToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
