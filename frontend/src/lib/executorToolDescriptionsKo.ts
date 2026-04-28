/**
 * Korean descriptions for the 38 BUILT_IN_TOOL_CLASSES tools that
 * ship with geny-executor.
 *
 * These translations live frontend-side because the executor library
 * is provider-neutral by design — adding a `description_ko` field to
 * every Python tool class would couple the framework to a specific
 * locale. Instead, the picker UI looks up the localised string here
 * when `locale === 'ko'` and falls back to the English description
 * exposed by `/api/tools/catalog/framework` when no entry is present.
 *
 * Names match `BUILT_IN_TOOL_CLASSES` keys
 * (`geny_executor.tools.built_in.__init__`). Add an entry whenever
 * the executor adds a new built-in tool.
 */

export const EXECUTOR_TOOL_DESCRIPTIONS_KO: Record<string, string> = {
  // ── filesystem family ──
  Read:
    '파일시스템에서 파일을 읽어 내용을 줄 번호와 함께 반환합니다. ' +
    'offset과 limit으로 큰 파일의 특정 구간만 읽을 수 있습니다.',
  Write:
    '파일을 작성합니다. 파일이 있으면 덮어쓰며, 없으면 새로 만듭니다. ' +
    '기존 파일을 수정할 때는 가능한 한 Edit를 우선 사용하세요.',
  Edit:
    '파일에서 정확한 문자열을 찾아 다른 문자열로 교체합니다. ' +
    'old_string은 파일 내에서 유일해야 하며, replace_all로 모든 일치를 한 번에 바꿀 수 있습니다.',
  Glob:
    'glob 패턴(예: `**/*.tsx`)으로 파일 경로를 매칭합니다. ' +
    '대규모 코드베이스에서 파일을 빠르게 찾을 때 유용하며 결과는 수정 시각 역순으로 정렬됩니다.',
  Grep:
    'ripgrep으로 파일 내용을 검색합니다. 정규식, 파일 타입 필터, 컨텍스트 줄 옵션을 지원합니다.',
  NotebookEdit:
    'Jupyter 노트북(`.ipynb`)의 특정 셀을 편집합니다. 셀 단위 추가/수정/삭제가 가능합니다.',

  // ── shell family ──
  Bash:
    '셸 명령을 실행합니다. 카탈로그에서 가장 권한이 큰 단일 도구이므로 permissions와 hooks와 함께 사용하세요. ' +
    '백그라운드 실행 옵션도 지원합니다.',

  // ── web family ──
  WebFetch:
    '단일 URL을 가져와 콘텐츠를 반환합니다. JavaScript 렌더링 없이 HTTP GET으로 정적 콘텐츠를 빠르게 가져올 때 적합합니다.',
  WebSearch:
    '웹 검색을 실행해 결과 목록(제목/URL/스니펫)을 반환합니다. 라이브 인터넷에 노출되므로 신중하게 사용하세요.',

  // ── workflow family ──
  TodoWrite:
    '에이전트가 명시적인 todo 리스트를 작성하고 진행 상황을 추적하도록 합니다. ' +
    '진행 가시성이 중요한 멀티스텝 작업에 적합합니다.',

  // ── meta family ──
  ToolSearch:
    'capability나 키워드로 도구를 검색합니다. 큰 도구 카탈로그에서 이름을 외우지 않고도 적절한 도구를 발견하는 데 사용합니다.',
  EnterPlanMode:
    '계획 전용(읽기 전용) 모드로 진입합니다. "먼저 계획부터 보여줘" 워크플로에서 사용 — ExitPlanMode로 빠져나오기 전에는 쓰기 도구가 비활성화됩니다.',
  ExitPlanMode:
    '계획 모드를 빠져나와 일반 실행 모드로 돌아갑니다. 계획이 승인된 후 실제 작업을 시작할 때 호출하세요.',

  // ── agent family ──
  Agent:
    'typed contract(SubagentType)를 가진 새 sub-agent 세션을 spawn합니다. ' +
    'Fan-out, 컨텍스트 격리, sub-task별 모델 스케일링에 사용합니다.',

  // ── interaction family ──
  AskUserQuestion:
    '사용자에게 질문을 던지고 답변을 기다립니다. 모호성 해소나 스펙 명확화 흐름에 사용 — 답변이 다음 턴으로 흘러 들어옵니다.',

  // ── notification family ──
  PushNotification:
    '사용자 측에 fire-and-forget 알림을 보냅니다. ' +
    '백그라운드 작업이 끝났음을 알릴 때 연결을 잡지 않고 사용 가능합니다.',

  // ── mcp family ──
  MCP:
    '연결된 MCP 서버의 도구를 호출합니다. 서버 이름이 prefix로 붙으며(`server.tool`), 인자는 해당 서버의 스키마를 따릅니다.',
  ListMcpResources:
    '연결된 MCP 서버가 광고하는 리소스(파일, DB 행 등 read-only 데이터)를 나열합니다.',
  ReadMcpResource:
    'MCP 리소스 URI를 읽어 콘텐츠를 반환합니다. mcp:// 스키마로 서버 간 리소스 참조가 가능합니다.',
  McpAuth:
    'MCP 서버에 대한 OAuth 2.0 authorization-code 흐름을 실행합니다. 토큰은 CredentialStore에 영속되어 다음 부팅 때 재사용됩니다.',

  // ── worktree family ──
  EnterWorktree:
    'git worktree를 push합니다. 에이전트가 분기된 브랜치에서 작업 후 깔끔하게 종료할 수 있도록 합니다 — WorkspaceStack과 통합되어 있습니다.',
  ExitWorktree:
    'git worktree를 pop하고 이전 작업 영역으로 돌아갑니다. 변경사항은 자동 stash되거나 사용자가 지정한 처리를 따릅니다.',

  // ── dev family ──
  LSP:
    'Language server(예: TypeScript, Python LSP)에 정의 이동, 참조 찾기, 진단 등 코드 인텔리전스 질의를 보냅니다.',
  REPL:
    '영속 Python 셸 세션입니다. 변수와 import가 호출 간 유지되며, 반복적인 데이터 탐색이나 ad-hoc 계산에 적합합니다.',
  Brief:
    '컴파일 에러, 테스트 실패, 린트 경고 등 빌드 결과를 요약해서 보여줍니다. 반복 개발 사이클에서 빠른 피드백을 얻을 때 사용합니다.',

  // ── operator family ──
  Config:
    'Geny 호스트 설정(settings.json 등)을 읽거나 씁니다. 셀프 운영 에이전트가 자신의 환경을 조정할 때 사용 — 신중하게 permission을 걸어야 합니다.',
  Monitor:
    '대상 파일(로그, 메트릭 등)을 tail-f 방식으로 스트리밍합니다. 진행 중인 작업의 출력을 실시간으로 관찰할 때 사용합니다.',
  SendUserFile:
    '사용자에게 파일을 전달합니다. 에이전트가 생성한 결과물(보고서, 아티팩트, 다운로드)을 사용자 측 채널로 전송합니다.',

  // ── messaging family ──
  SendMessage:
    '세션 간 사용자 채팅에 메시지를 게시합니다. cron이나 sub-agent에서 사용자 채팅으로 알림을 보낼 때 유용합니다.',

  // ── cron family ──
  CronCreate:
    '에이전트가 자기 자신이나 다른 에이전트를 cron 표현식에 따라 주기적으로 실행하도록 스케줄링합니다.',
  CronDelete:
    '예약된 cron 작업을 ID로 제거합니다. 더 이상 필요 없는 자동화나 잘못 등록된 항목을 정리할 때 사용합니다.',
  CronList:
    '현재 호스트에 등록된 모든 cron 작업을 나열합니다. 다음 실행 시각, 마지막 실행 결과, 등록자 등을 함께 반환합니다.',

  // ── tasks family ──
  TaskCreate:
    '장기 실행 task를 등록합니다. 에이전트가 비동기 작업을 시작하고 다른 일을 하다가 나중에 결과를 확인할 수 있게 합니다.',
  TaskGet:
    '특정 task의 현재 상태(pending / running / completed / failed)와 메타데이터를 ID로 조회합니다.',
  TaskList:
    '활성 또는 최근 task를 나열합니다. 상태 필터로 좁힐 수 있어 진행 중인 작업을 한눈에 보기 좋습니다.',
  TaskUpdate:
    'task의 메타데이터를 업데이트합니다. 우선순위 변경, 메모 추가, 완료 마킹 등에 사용합니다.',
  TaskOutput:
    '실행 중이거나 완료된 task의 출력 스트림을 가져옵니다. 결과를 후속 처리하거나 사용자에게 보여줄 때 사용합니다.',
  TaskStop:
    '실행 중인 task를 중단합니다. SIGTERM을 보낸 뒤 grace period 후 SIGKILL로 강제 종료합니다.',
};
