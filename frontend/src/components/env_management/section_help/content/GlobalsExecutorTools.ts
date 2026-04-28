/**
 * Help content for Globals → Executor Built-in Tool panel.
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Executor built-in tools',
  summary:
    'The 38 first-party tools that ship inside `geny-executor` itself. Every name maps to a Python class in `geny_executor.tools.built_in.BUILT_IN_TOOL_CLASSES`. Selected names land in `manifest.tools.built_in`.',
  whatItDoes: `These are the tools the executor library knows about by default — they ship with the package and don't require any host-side wiring. Selection here decides which ones the agent loop is **allowed** to dispatch; Stage 10 then walks \`state.pending_tool_calls\` and routes each to the registered handler.

The catalog is grouped into 14 feature families (\`BUILT_IN_TOOL_FEATURES\`). Selection is by individual name, not by family — the family grouping in the UI is purely organisational.

**The wildcard \`["*"]\`** ("Select all") inherits the entire catalog, including any tools added in a future executor version. Use this for trusted, full-capability agents where new tools should auto-enable. For sandboxed or compliance-critical agents, use an explicit list so an executor upgrade doesn't silently grant new capabilities.

**Per-stage narrowing**: this panel sets the global allowlist. Stage 10's \`tool_binding\` field can further narrow it per stage (e.g., "Stage 12's sub-agent only sees Read / Grep, not Bash"). The intersection of global ∩ per-stage wins.

**Permissions interplay**: even a selected tool gets blocked at runtime if a \`permissions\` rule (host-level \`settings.json\`) denies it. Permissions are evaluated by Stage 4's permission guard — and the deny outcome is stronger than any selection here.

**Tool execution flow** (summarised):

- Stage 9 parses the LLM's \`tool_use\` blocks into \`state.pending_tool_calls\`
- Stage 4 (permission guard, if in chain) filters them against allow/deny rules
- Stage 11 (tool review, if active) flags suspicious calls for HITL inspection
- Stage 10 dispatches each remaining call to its registered handler
- Tool errors become \`tool_result\` blocks with \`is_error: true\` — they don't halt the pipeline`,
  configFields: [
    {
      name: 'manifest.tools.built_in',
      label: 'Built-in tool names',
      type: 'list[string]',
      default: '[]',
      description:
        'Tool name strings, or `["*"]` for "all tools in the executor\'s built-in catalog". Empty list = no executor tools attached. Stored at the manifest top level.',
    },
  ],
  options: [
    {
      id: 'filesystem',
      label: 'filesystem family',
      description:
        'Read / Write / Edit / Glob / Grep / NotebookEdit — direct filesystem access. The CWD comes from `WorkspaceStack.current().cwd`; Stage 10 doesn\'t sandbox these calls so all the security comes from permissions and hooks.',
      bestFor: [
        'Code-touching agents (Claude Code-style)',
        'Documentation generators and refactoring bots',
        'Anything that operates on a working tree',
      ],
      avoidWhen: [
        'Public-facing chat bots without strict permissions',
        'Multi-tenant deployments without worktree isolation',
      ],
    },
    {
      id: 'shell',
      label: 'shell family',
      description:
        'Bash — shell command execution. The single most-permissive tool in the catalog; combine with permissions and hooks unconditionally.',
      bestFor: ['Build / test runners', 'DevOps automation'],
      avoidWhen: ['Anything user-facing without sandboxing'],
    },
    {
      id: 'agent',
      label: 'agent family',
      description:
        'Agent — sub-agent dispatch. The Agent tool spawns a fresh `AgentSession` with a typed contract (`SubagentType`). Used for fan-out, isolation, and per-task model scaling (smaller model for sub-tasks).',
      bestFor: [
        'Orchestrator agents',
        'Tasks that benefit from sub-agent isolation (no leaked context)',
      ],
    },
    {
      id: 'mcp',
      label: 'mcp family',
      description:
        'MCP / ListMcpResources / ReadMcpResource / McpAuth — surface for Model Context Protocol servers. Required when `manifest.tools.mcp_servers` is non-empty.',
      bestFor: ['Any environment with MCP servers attached'],
    },
    {
      id: 'tasks',
      label: 'tasks family',
      description:
        'TaskCreate / TaskGet / TaskList / TaskUpdate / TaskOutput / TaskStop — long-running task registry (Stage 13). Lets the agent kick off async work and check on it across turns.',
      bestFor: [
        'Long-running operations (training jobs, data pipelines)',
        'Cross-turn coordination',
      ],
    },
    {
      id: 'workflow',
      label: 'workflow family',
      description:
        'TodoWrite — explicit task plan tracking. The agent writes a numbered todo list and ticks items off as it works.',
      bestFor: [
        'Multi-step tasks where progress visibility matters',
        'User-trust scenarios (the user can see what the agent intends to do)',
      ],
    },
    {
      id: 'meta',
      label: 'meta family',
      description:
        'ToolSearch / EnterPlanMode / ExitPlanMode — meta-control. ToolSearch lets the agent discover tools by capability instead of memorising names; PlanMode is a read-only execution mode for "please show me your plan first" workflows.',
      bestFor: ['Plan-then-execute UX', 'Large tool catalogs'],
    },
    {
      id: 'cron',
      label: 'cron family',
      description:
        'CronCreate / CronDelete / CronList — scheduled task management (cron extra). Lets the agent schedule itself or other agents to run later.',
      bestFor: ['Self-scheduling agents', 'Periodic monitoring jobs'],
    },
    {
      id: 'worktree',
      label: 'worktree family',
      description:
        'EnterWorktree / ExitWorktree — git worktree push/pop integrated with the executor\'s WorkspaceStack. The agent can branch off, work, then exit cleanly.',
      bestFor: [
        'Branch-isolated experimental work',
        'Concurrent edits without conflicts',
      ],
    },
    {
      id: 'dev',
      label: 'dev family',
      description:
        'LSP / REPL / Brief — developer-tool integrations. LSP exposes language-server capabilities; REPL gives a persistent Python shell; Brief surfaces compile errors / test failures.',
      bestFor: ['Code intelligence', 'Iterative development'],
    },
    {
      id: 'web',
      label: 'web family',
      description:
        'WebFetch / WebSearch — internet access. WebFetch retrieves a single URL; WebSearch runs a search query. Use cautiously — exposes the agent to live, untrusted content.',
      bestFor: ['Research tasks', 'Fact-checking workflows'],
      avoidWhen: ['Air-gapped or compliance-locked environments'],
    },
    {
      id: 'interaction',
      label: 'interaction family',
      description:
        'AskUserQuestion — HITL prompt. The agent pauses and asks the human a question; the answer flows back into the next turn. Different from Stage 15 HITL (which is approval-flow oriented).',
      bestFor: ['Disambiguation flows', 'Spec-clarification UX'],
    },
    {
      id: 'notification',
      label: 'notification family',
      description:
        'PushNotification — fire-and-forget user-side ping. Useful when the agent works in the background and wants to surface "I\'m done" without holding a connection.',
      bestFor: ['Long-running tasks', 'Async user notification'],
    },
    {
      id: 'operator',
      label: 'operator family',
      description:
        'Config / Monitor / SendUserFile — operator-style admin tools. Config reads / writes settings; Monitor streams logs from a target file; SendUserFile delivers a file to the user.',
      bestFor: ['DevOps / SRE agents', 'Self-administering deployments'],
    },
    {
      id: 'messaging',
      label: 'messaging family',
      description:
        'SendMessage — cross-session user message delivery. The agent can post into the user\'s chat from a non-chat session (cron, sub-agent, etc.).',
      bestFor: ['Cron-triggered notifications', 'Sub-agent → parent comms'],
    },
  ],
  relatedSections: [
    {
      label: 'Geny Built-in tools (next tab)',
      body: 'Geny adds its own host-side tools via GenyToolProvider — separate catalog, separate manifest field (tools.external).',
    },
    {
      label: 'Stage 10 — Tools',
      body: 'Stage 10 is what actually executes tool calls. The list here is what Stage 10 is allowed to dispatch to. Per-stage tool_binding can narrow the global list further.',
    },
    {
      label: 'Stage 4 — Permission guard',
      body: 'Permission guard runs before Stage 10 if it\'s in the chain — even a selected tool gets blocked if a deny rule matches.',
    },
    {
      label: 'Stage 11 — Tool review',
      body: 'Stage 11 audits tool calls for safety (5-reviewer chain). Pair with Bash / WebFetch / shell tools for high-risk environments.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/__init__.py:BUILT_IN_TOOL_CLASSES',
};

const ko: SectionHelpContent = {
  title: 'Executor 빌트인 도구',
  summary:
    '`geny-executor`에 포함된 38개 first-party 도구. 각 이름은 `geny_executor.tools.built_in.BUILT_IN_TOOL_CLASSES`의 Python 클래스에 매핑. 선택된 이름이 `manifest.tools.built_in`에 들어갑니다.',
  whatItDoes: `실행기 라이브러리에 기본 포함된 도구들 — 패키지에 함께 ship되며 호스트 측 와이어업이 필요 없습니다. 여기서 선택하면 에이전트 루프가 dispatch할 수 있는 **허용 목록**이 결정되고, 10단계가 \`state.pending_tool_calls\`를 walk하며 등록된 핸들러로 라우팅합니다.

카탈로그는 14개 feature family (\`BUILT_IN_TOOL_FEATURES\`)로 그룹화되어 있어요. 선택은 개별 이름 단위 — UI의 family 그루핑은 단순한 organisational 표현입니다.

**와일드카드 \`["*"]\`** ("Select all")는 전체 카탈로그를 상속, 향후 실행기 버전에서 추가될 도구도 자동으로 포함. 새 도구를 자동으로 사용 가능하게 하고 싶은 신뢰 환경에 권장. 샌드박스 또는 컴플라이언스가 critical한 에이전트는 명시적 리스트 사용 — 실행기 업그레이드가 silent하게 새 능력 부여하지 않도록.

**단계별 좁히기**: 이 패널은 글로벌 allowlist를 설정. 10단계의 \`tool_binding\` 필드로 단계별로 더 좁힐 수 있어요 (예: "12단계 sub-agent는 Read / Grep만 보고, Bash는 못 봄"). 글로벌 ∩ 단계별 교집합이 적용.

**Permissions 상호작용**: 선택된 도구라도 \`permissions\` 규칙 (호스트 레벨 \`settings.json\`)이 deny하면 런타임에 차단. Permissions는 4단계 permission guard에서 평가 — deny 결과가 어떤 선택보다도 강합니다.

**도구 실행 흐름** (요약):

- 9단계가 LLM의 \`tool_use\` 블록을 \`state.pending_tool_calls\`로 파싱
- 4단계 (permission guard, 체인에 있으면)가 allow/deny 규칙으로 필터링
- 11단계 (tool review, 활성 시)가 의심스러운 호출에 HITL 검토 플래그
- 10단계가 남은 호출을 등록된 핸들러로 dispatch
- 도구 에러는 \`is_error: true\`인 \`tool_result\` 블록 — 파이프라인을 멈추지 않음`,
  configFields: [
    {
      name: 'manifest.tools.built_in',
      label: 'Built-in 도구 이름',
      type: 'list[string]',
      default: '[]',
      description:
        '도구 이름 문자열, 또는 "실행기 빌트인 카탈로그의 모든 도구"를 의미하는 `["*"]`. 빈 리스트 = executor 도구 미부착. 매니페스트 최상위에 저장.',
    },
  ],
  options: [
    {
      id: 'filesystem',
      label: 'filesystem family',
      description:
        'Read / Write / Edit / Glob / Grep / NotebookEdit — 직접 파일시스템 접근. CWD는 `WorkspaceStack.current().cwd`에서 가져옵니다; 10단계가 이 호출들을 샌드박싱하지 않으므로 모든 보안은 permissions와 hooks에서.',
      bestFor: [
        '코드를 만지는 에이전트 (Claude Code 스타일)',
        '문서 생성기와 리팩토링 봇',
        '워킹 트리에서 동작하는 모든 작업',
      ],
      avoidWhen: [
        '엄격한 permissions 없는 공개 챗봇',
        '워크트리 격리 없는 멀티 테넌트 배포',
      ],
    },
    {
      id: 'shell',
      label: 'shell family',
      description:
        'Bash — 셸 명령 실행. 카탈로그에서 가장 권한이 큰 단일 도구; permissions와 hooks와 무조건 함께 사용.',
      bestFor: ['빌드 / 테스트 러너', 'DevOps 자동화'],
      avoidWhen: ['샌드박싱 없는 사용자 대면 환경'],
    },
    {
      id: 'agent',
      label: 'agent family',
      description:
        'Agent — sub-agent dispatch. Agent 도구는 typed contract (`SubagentType`)로 새 `AgentSession`을 spawn. Fan-out, 격리, task-별 모델 스케일링 (sub-task에 작은 모델)에 사용.',
      bestFor: [
        '오케스트레이터 에이전트',
        'sub-agent 격리 (컨텍스트 누출 없음)가 도움 되는 작업',
      ],
    },
    {
      id: 'mcp',
      label: 'mcp family',
      description:
        'MCP / ListMcpResources / ReadMcpResource / McpAuth — Model Context Protocol 서버용 인터페이스. `manifest.tools.mcp_servers`가 비어있지 않으면 필수.',
      bestFor: ['MCP 서버가 부착된 모든 환경'],
    },
    {
      id: 'tasks',
      label: 'tasks family',
      description:
        'TaskCreate / TaskGet / TaskList / TaskUpdate / TaskOutput / TaskStop — long-running task registry (13단계). 에이전트가 비동기 작업을 시작하고 턴을 가로지르며 확인.',
      bestFor: [
        '장기 실행 작업 (학습 잡, 데이터 파이프라인)',
        '턴 간 조율',
      ],
    },
    {
      id: 'workflow',
      label: 'workflow family',
      description:
        'TodoWrite — 명시적 task plan 추적. 에이전트가 번호 매긴 todo 리스트를 쓰고 작업하며 체크오프.',
      bestFor: [
        '진행 가시성이 중요한 멀티스텝 작업',
        '사용자 신뢰 시나리오 (의도 가시화)',
      ],
    },
    {
      id: 'meta',
      label: 'meta family',
      description:
        'ToolSearch / EnterPlanMode / ExitPlanMode — 메타 컨트롤. ToolSearch는 이름 암기 없이 capability로 도구 발견; PlanMode는 "먼저 계획부터 보여줘" 워크플로용 read-only 모드.',
      bestFor: ['Plan-then-execute UX', '큰 도구 카탈로그'],
    },
    {
      id: 'cron',
      label: 'cron family',
      description:
        'CronCreate / CronDelete / CronList — 스케줄 task 관리 (cron extra). 에이전트가 자기 자신이나 다른 에이전트를 나중에 실행되도록 스케줄.',
      bestFor: ['셀프 스케줄링 에이전트', '주기적 모니터링 잡'],
    },
    {
      id: 'worktree',
      label: 'worktree family',
      description:
        'EnterWorktree / ExitWorktree — 실행기의 WorkspaceStack과 통합된 git worktree push/pop. 에이전트가 분기해서 작업하고 깔끔하게 종료.',
      bestFor: [
        '브랜치 격리된 실험적 작업',
        '충돌 없는 동시 편집',
      ],
    },
    {
      id: 'dev',
      label: 'dev family',
      description:
        'LSP / REPL / Brief — 개발 도구 통합. LSP는 language server 능력 노출; REPL은 영속 Python shell; Brief는 컴파일 에러 / 테스트 실패 노출.',
      bestFor: ['코드 인텔리전스', '반복 개발'],
    },
    {
      id: 'web',
      label: 'web family',
      description:
        'WebFetch / WebSearch — 인터넷 접근. WebFetch는 단일 URL 가져오기; WebSearch는 검색 쿼리 실행. 신중하게 — 라이브, 신뢰되지 않은 콘텐츠에 에이전트 노출.',
      bestFor: ['리서치 작업', '사실 확인 워크플로'],
      avoidWhen: ['에어갭 또는 컴플라이언스 잠금 환경'],
    },
    {
      id: 'interaction',
      label: 'interaction family',
      description:
        'AskUserQuestion — HITL prompt. 에이전트가 일시 정지하고 사용자에게 질문; 답이 다음 턴으로 흘러 들어옴. 15단계 HITL과 다름 (그쪽은 approval flow 지향).',
      bestFor: ['모호성 해소 흐름', '스펙 명확화 UX'],
    },
    {
      id: 'notification',
      label: 'notification family',
      description:
        'PushNotification — fire-and-forget 사용자 측 핑. 에이전트가 백그라운드에서 일하고 연결을 잡지 않은 채 "끝났어"를 알리고 싶을 때.',
      bestFor: ['장기 실행 작업', '비동기 사용자 알림'],
    },
    {
      id: 'operator',
      label: 'operator family',
      description:
        'Config / Monitor / SendUserFile — operator 스타일 admin 도구. Config는 설정 read/write; Monitor는 대상 파일에서 로그 스트리밍; SendUserFile은 사용자에게 파일 전달.',
      bestFor: ['DevOps / SRE 에이전트', '셀프 운영 배포'],
    },
    {
      id: 'messaging',
      label: 'messaging family',
      description:
        'SendMessage — 세션 간 사용자 메시지 전달. 에이전트가 챗 아닌 세션 (cron, sub-agent 등)에서 사용자 챗에 포스팅.',
      bestFor: ['Cron 트리거 알림', 'Sub-agent → parent 통신'],
    },
  ],
  relatedSections: [
    {
      label: 'Geny Built-in tools (다음 탭)',
      body: 'Geny가 GenyToolProvider로 추가하는 호스트 측 도구 — 별도 카탈로그, 별도 매니페스트 필드 (tools.external).',
    },
    {
      label: '10단계 — Tools',
      body: '실제 도구 호출을 실행하는 곳. 여기 리스트가 10단계가 dispatch할 수 있는 것. 단계별 tool_binding으로 글로벌 리스트를 더 좁힐 수 있음.',
    },
    {
      label: '4단계 — Permission guard',
      body: 'Permission guard가 체인에 있으면 10단계 전에 실행 — 선택된 도구라도 deny 규칙에 걸리면 차단.',
    },
    {
      label: '11단계 — Tool review',
      body: '11단계가 안전성을 위해 도구 호출 감사 (5 reviewer chain). 고위험 환경에선 Bash / WebFetch / shell 도구와 함께.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/__init__.py:BUILT_IN_TOOL_CLASSES',
};

export const globalsExecutorToolsHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
