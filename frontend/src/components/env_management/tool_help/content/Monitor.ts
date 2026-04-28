/** Tool detail — Monitor (executor / operator family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `Monitor streams a target file's content as it grows — like \`tail -f\` but with structure the agent can reason about. Each call returns the new bytes since last call (or the tail of the file if first call), plus a cursor the next call uses to resume.

Common pairings:
  - \`Bash run_in_background\` writing to a logfile, Monitor reading from that file → real-time observation of long-running services.
  - Build / test runners that emit progress to a known logfile.
  - Multi-process pipelines where Monitor is the convergence point.

Cursor model: the executor keeps a (session, file_path) → byte_offset map. Each Monitor call returns content from offset to EOF and updates the offset. \`cursor: "reset"\` rewinds to the beginning; \`cursor: "tail"\` jumps to EOF (useful when the agent doesn't care about history).

Filtering: \`grep_pattern\` filters returned lines server-side, so the response only contains matching lines. Reduces context cost when the file is noisy and the agent only needs specific events (errors, warnings, completions).

When the file doesn't exist yet, Monitor returns empty content with a flag \`exists: false\` rather than erroring — useful when polling for a file that's about to be created by a background task.`,
  bestFor: [
    'Watching a long-running process via its logfile',
    'Multi-pass: read updates, summarise, re-call for next chunk',
    'Filtered tailing — only show lines matching a pattern',
  ],
  avoidWhen: [
    'You need the entire file contents at once — Read with no offset/limit is more direct',
    'The file is huge and you only need a tiny portion — use Grep to find what you want',
    'The data isn\'t in a file — write to one first via Bash redirect',
  ],
  gotchas: [
    'Cursor is per-(session, file). Different sub-agents have separate cursors.',
    'File rotation (e.g., logrotate) can confuse the cursor — the byte offset becomes meaningless after rotation. Reset on rotation.',
    'Filter pattern is regex (rg-flavoured); broken patterns return zero matches silently.',
    'Returns only what\'s flushed to disk. Buffered output from the writing process may lag visibly.',
  ],
  examples: [
    {
      caption: 'Tail a build log filtering for errors',
      body: `{
  "file_path": "/tmp/build.log",
  "grep_pattern": "ERROR|FAIL"
}`,
      note: 'Returns only lines matching the pattern since last call. Cursor advances to EOF.',
    },
  ],
  relatedTools: ['Bash', 'Read', 'Grep', 'Brief'],
  relatedStages: [],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/monitor_tool.py:MonitorTool',
};

const ko: ToolDetailContent = {
  body: `Monitor는 대상 파일의 콘텐츠를 자라남에 따라 스트리밍합니다 — \`tail -f\` 같지만 에이전트가 추론할 수 있는 구조 보유. 각 호출이 마지막 호출 이후 새 bytes 반환(또는 첫 호출이면 파일 tail), 다음 호출이 재개할 cursor 함께.

흔한 페어링:
  - \`Bash run_in_background\`가 logfile에 쓰고 Monitor가 그 파일 읽기 → 장기 서비스 실시간 관찰.
  - 알려진 logfile에 진행 emit하는 빌드 / 테스트 러너.
  - Monitor가 수렴 지점인 멀티 프로세스 파이프라인.

Cursor 모델: 실행기가 (session, file_path) → byte_offset 맵 유지. 각 Monitor 호출이 offset부터 EOF까지 콘텐츠 반환, offset 업데이트. \`cursor: "reset"\`은 처음으로 rewind; \`cursor: "tail"\`은 EOF로 점프(에이전트가 history 신경 안 쓸 때 유용).

필터링: \`grep_pattern\`이 반환되는 줄을 서버 측에서 필터링, 응답에 매칭 줄만 포함. 파일이 noisy하고 에이전트가 특정 이벤트(에러, 경고, 완료)만 필요할 때 컨텍스트 비용 감소.

파일이 아직 없을 때 Monitor는 에러 대신 \`exists: false\` 플래그와 함께 빈 콘텐츠 반환 — 백그라운드 task가 곧 생성할 파일 polling에 유용.`,
  bestFor: [
    'logfile로 장기 프로세스 관찰',
    'Multi-pass: 업데이트 읽기, 요약, 다음 청크용 재호출',
    '필터 tailing — 패턴 매칭 줄만 표시',
  ],
  avoidWhen: [
    '전체 파일 콘텐츠 한 번에 필요 — offset/limit 없는 Read가 더 직접적',
    '파일이 거대하고 작은 부분만 필요 — Grep으로 원하는 것 찾기',
    '데이터가 파일 안 아님 — Bash 리다이렉트로 먼저 파일에 쓰기',
  ],
  gotchas: [
    'Cursor는 (세션, 파일)별. 다른 sub-agent는 별도 cursor.',
    '파일 rotation(예: logrotate)이 cursor 혼란 — rotation 후 byte offset이 무의미. Rotation 시 reset.',
    '필터 패턴은 regex(rg 풍미); 잘못된 패턴은 silent하게 매칭 없음 반환.',
    '디스크에 flush된 것만 반환. 쓰기 프로세스의 버퍼된 출력은 보이게 lag 가능.',
  ],
  examples: [
    {
      caption: '에러 필터링하며 빌드 로그 tail',
      body: `{
  "file_path": "/tmp/build.log",
  "grep_pattern": "ERROR|FAIL"
}`,
      note: '마지막 호출 이후 패턴 매칭 줄만 반환. Cursor가 EOF로 진행.',
    },
  ],
  relatedTools: ['Bash', 'Read', 'Grep', 'Brief'],
  relatedStages: [],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/monitor_tool.py:MonitorTool',
};

export const monitorToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
