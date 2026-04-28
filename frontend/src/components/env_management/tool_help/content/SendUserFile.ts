/** Tool detail — SendUserFile (executor / operator family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `SendUserFile delivers a file artefact to the user's side — a download / share / "save this for me" affordance. The executor packages the file (path or inline content), tags it with a display name + mime type, and emits it through the host's user-output channel.

Two modes:
  - \`from_path\`: the agent writes the file with Write / Bash and points SendUserFile at the path. Useful for generated reports, exported CSVs, screenshots, etc.
  - \`from_content\`: the agent passes inline content (bytes / base64), the executor saves it transiently and delivers. Avoids a Write step for short-lived artefacts.

Display name and mime type are hints to the host UI for rendering — preview vs download, icon selection, sort grouping. The host may or may not honour them depending on its frontend.

Different from Read returning content: Read shows the agent the contents (for the agent to reason about); SendUserFile pushes the file to the human (for them to use). Read responds in the conversation; SendUserFile creates a delivery event.`,
  bestFor: [
    'Delivering a generated report (CSV, PDF, etc.) to the user',
    'Sharing a screenshot or diagram the agent produced',
    'Exporting an artefact the user wants to keep beyond the session',
  ],
  avoidWhen: [
    'You want the agent to read the file — that\'s Read',
    'The "file" is just a string the user can read in chat — embed it in the response',
    'Sending many large files in one turn — chunk over multiple turns or compress',
  ],
  gotchas: [
    'Path mode requires the file to be readable by the executor process at delivery time. Race conditions with concurrent Write / Bash are possible.',
    'Some host frontends size-cap deliveries (e.g., 50MB). Genuinely large outputs may need a different channel (S3 upload, etc.).',
    'Mime type is a hint, not enforcement — the file content is delivered as-is.',
    'Delivery is asynchronous from the agent\'s perspective. The tool returns success once enqueued, not once the user receives.',
  ],
  examples: [
    {
      caption: 'Send a generated PDF report',
      body: `{
  "from_path": "/tmp/report-2026-04.pdf",
  "display_name": "Q1 Performance Report",
  "mime_type": "application/pdf"
}`,
      note: 'Host UI surfaces the file as a download with the display name; mime type drives icon / preview behaviour.',
    },
  ],
  relatedTools: ['Write', 'Bash', 'PushNotification'],
  relatedStages: [],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/send_user_file_tool.py:SendUserFileTool',
};

const ko: ToolDetailContent = {
  body: `SendUserFile은 파일 아티팩트를 사용자 측에 전달합니다 — 다운로드 / 공유 / "이거 저장해줘" affordance. 실행기가 파일 패키징(경로 또는 인라인 콘텐츠), display 이름 + mime type 태그, 호스트의 user-output 채널로 emit.

두 모드:
  - \`from_path\`: 에이전트가 Write / Bash로 파일 작성 후 경로를 SendUserFile에 지정. 생성된 리포트, export된 CSV, 스크린샷 등에 유용.
  - \`from_content\`: 에이전트가 인라인 콘텐츠(bytes / base64) 전달, 실행기가 transient하게 저장 후 전달. 단기 아티팩트의 Write 단계 회피.

Display 이름과 mime type은 호스트 UI 렌더링용 힌트 — preview vs 다운로드, 아이콘 선택, sort 그루핑. 호스트가 frontend에 따라 honour하거나 안 할 수 있음.

콘텐츠 반환하는 Read와 다름: Read는 에이전트에게 콘텐츠 보여줌(에이전트가 추론하도록); SendUserFile은 사람에게 파일 push(사용하도록). Read는 대화에서 응답; SendUserFile은 delivery 이벤트 생성.`,
  bestFor: [
    '생성된 리포트(CSV, PDF 등)를 사용자에게 전달',
    '에이전트가 생성한 스크린샷 또는 다이어그램 공유',
    '사용자가 세션 너머로 보관하고 싶은 아티팩트 export',
  ],
  avoidWhen: [
    '에이전트가 파일 읽기 원함 — 그건 Read',
    '"파일"이 사용자가 채팅에서 읽을 수 있는 문자열 — 응답에 임베드',
    '한 턴에 큰 파일 여럿 전송 — 여러 턴에 청크 또는 압축',
  ],
  gotchas: [
    'Path 모드는 delivery 시점에 실행기 프로세스가 파일 읽기 가능해야 함. 동시 Write / Bash와 race condition 가능.',
    '일부 호스트 frontend는 delivery 크기 cap(예: 50MB). 진짜 큰 출력은 다른 채널 필요(S3 업로드 등).',
    'Mime type은 힌트, 강제 아님 — 파일 콘텐츠는 그대로 전달.',
    '에이전트 관점에서 delivery는 비동기. 도구는 enqueue되면 성공 반환, 사용자 수신 후 아님.',
  ],
  examples: [
    {
      caption: '생성된 PDF 리포트 보내기',
      body: `{
  "from_path": "/tmp/report-2026-04.pdf",
  "display_name": "Q1 Performance Report",
  "mime_type": "application/pdf"
}`,
      note: '호스트 UI가 display 이름과 함께 파일을 다운로드로 표면화; mime type이 아이콘 / preview 동작 결정.',
    },
  ],
  relatedTools: ['Write', 'Bash', 'PushNotification'],
  relatedStages: [],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/send_user_file_tool.py:SendUserFileTool',
};

export const sendUserFileToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
