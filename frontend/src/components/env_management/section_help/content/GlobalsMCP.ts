/**
 * Help content for Globals → MCP panel.
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'MCP servers',
  summary:
    'Model Context Protocol servers attached to this environment. Each entry boots a subprocess on session start, advertises tools / resources / prompts, and is wired through `MCPManager`. Stored at `manifest.tools.mcp_servers`.',
  whatItDoes: `MCP is the third tool catalog (alongside Executor Built-in and Geny Built-in). Unlike those, MCP servers are **out-of-process** — each entry spawns its own subprocess at session boot, communicates with the executor over stdio (or SSE for HTTP servers), and advertises capabilities dynamically.

**Server entry shape** (per element of \`tools.mcp_servers\`):

- \`name\`: stable identifier used in tool name prefixes (e.g., \`filesystem.read_file\` for a server named \`filesystem\`).
- \`command\` + \`args\`: how to spawn the server process. Most MCP servers are Node CLIs (\`npx -y @modelcontextprotocol/server-filesystem /path\`) but anything spawnable works.
- \`env\`: per-server environment variables. Often used for API keys (\`GITHUB_TOKEN\` etc.).
- \`disabled\`: skip this server at boot without removing the entry.
- \`autoApprove\`: list of tool names the agent can call without HITL approval.

**Lifecycle**:

1. \`MCPManager\` reads \`tools.mcp_servers\` and spawns each enabled subprocess.
2. After handshake (\`initialize\` → \`tools/list\` → \`resources/list\` → \`prompts/list\`), every advertised tool is registered in the unified tool registry visible to Stage 6 / 10. Tool names are prefixed with the server name to avoid collisions.
3. The agent calls a tool via the \`MCP\` built-in (or via the prefixed name directly); \`MCPManager\` dispatches the call to the right subprocess.
4. On session end, all subprocesses are terminated.

**Resources** (read-only data, like files or DB rows) are accessible via \`ListMcpResources\` / \`ReadMcpResource\` built-ins. **Prompts** can be projected into the skill catalog via \`mcp_prompts_to_skills(manager)\` so the agent treats them as discoverable workflows.

**OAuth**: long-lived servers (Slack, GitHub, etc.) often need OAuth. The executor's \`McpAuth\` tool runs the full authorization-code dance, persists tokens via the configured CredentialStore, and reuses them on subsequent boots.

**Manifest vs Library**: this panel shows the env-scoped count. The actual server definitions live at \`manifest.tools.mcp_servers\` (env-specific) AND in a host-level admin store (shared defaults). Use the Library MCP Servers tab to manage host-level defaults; per-env overrides happen via manifest editing.`,
  configFields: [
    {
      name: 'manifest.tools.mcp_servers',
      label: 'MCP server definitions',
      type: 'list[dict]',
      default: '[]',
      description:
        'List of server entries. Each describes how to spawn the server, what env vars to pass, and which tools may auto-approve. Order is irrelevant — servers boot in parallel.',
    },
    {
      name: 'name',
      label: 'name (per entry)',
      type: 'string',
      required: true,
      description:
        'Stable identifier. Used as the prefix for tool names (e.g., name="git" → tool "git.commit"). Must be unique within the manifest.',
    },
    {
      name: 'command',
      label: 'command (per entry)',
      type: 'string',
      required: true,
      description:
        'Executable to spawn. Most MCP servers are Node CLIs invoked via npx, but Python / Rust / Go servers all work as long as they speak MCP over stdio.',
    },
    {
      name: 'args',
      label: 'args (per entry)',
      type: 'list[string]',
      description:
        'Command-line arguments. e.g., for the filesystem server: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/root"].',
    },
    {
      name: 'env',
      label: 'env (per entry)',
      type: 'dict[string, string]',
      description:
        'Per-server environment variables. Used for API tokens and config. Inherits the executor process env on top of these.',
    },
    {
      name: 'disabled',
      label: 'disabled (per entry)',
      type: 'boolean',
      default: 'false',
      description:
        'When true, the server entry is kept but skipped at boot. Useful for temporarily silencing a server without losing its config.',
    },
    {
      name: 'autoApprove',
      label: 'autoApprove (per entry)',
      type: 'list[string]',
      description:
        'Tool names that bypass HITL approval (no permission prompt). Use sparingly — usually only for read-only tools.',
    },
  ],
  options: [],
  relatedSections: [
    {
      label: 'Executor Built-in: mcp family',
      body: 'The MCP / ListMcpResources / ReadMcpResource / McpAuth tools must be selected for the agent to actually interact with attached servers. Selecting MCP servers without those tools means the servers boot but the agent can\'t reach them.',
    },
    {
      label: 'Stage 10 — Tools',
      body: 'Stage 10 dispatches MCP tool calls the same way it dispatches built-in tool calls — the registry is unified.',
    },
    {
      label: 'Skills',
      body: 'MCP prompts can be projected into the skill catalog via `mcp_prompts_to_skills(manager)` — the agent then discovers them as Skill entries.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/mcp/manager.py:MCPManager',
};

const ko: SectionHelpContent = {
  title: 'MCP 서버',
  summary:
    '이 환경에 부착된 Model Context Protocol 서버. 각 항목이 세션 시작 시 서브프로세스로 부팅되어 도구 / 리소스 / 프롬프트를 광고하고, `MCPManager`를 통해 와이어업됩니다. `manifest.tools.mcp_servers`에 저장.',
  whatItDoes: `MCP는 세 번째 도구 카탈로그 (Executor Built-in, Geny Built-in과 나란히). 다른 둘과 달리 MCP 서버는 **out-of-process** — 각 항목이 세션 부팅 시 자체 서브프로세스를 spawn, 실행기와 stdio (또는 HTTP 서버는 SSE)로 통신, 동적으로 capability 광고.

**서버 항목 형태** (각 \`tools.mcp_servers\` 요소):

- \`name\`: 도구 이름 prefix로 사용되는 stable 식별자 (예: \`filesystem\` 이름의 서버는 \`filesystem.read_file\`).
- \`command\` + \`args\`: 서버 프로세스 spawn 방법. 대부분의 MCP 서버는 Node CLI (\`npx -y @modelcontextprotocol/server-filesystem /path\`)이지만 spawnable한 모든 것 가능.
- \`env\`: 서버별 환경 변수. API 키 (\`GITHUB_TOKEN\` 등)에 자주 사용.
- \`disabled\`: 항목 제거 없이 부팅 시 건너뛰기.
- \`autoApprove\`: 에이전트가 HITL 승인 없이 호출 가능한 도구 이름들.

**라이프사이클**:

1. \`MCPManager\`가 \`tools.mcp_servers\`를 읽어 활성 서브프로세스를 spawn.
2. 핸드셰이크 (\`initialize\` → \`tools/list\` → \`resources/list\` → \`prompts/list\`) 후, 광고된 모든 도구가 6단계 / 10단계가 보는 통합 tool registry에 등록. 도구 이름은 충돌 방지를 위해 서버 이름으로 prefix.
3. 에이전트가 \`MCP\` 빌트인 (또는 prefix된 이름 직접)으로 도구 호출; \`MCPManager\`가 호출을 올바른 서브프로세스로 dispatch.
4. 세션 종료 시 모든 서브프로세스 terminate.

**리소스** (파일 / DB 행 같은 read-only 데이터)는 \`ListMcpResources\` / \`ReadMcpResource\` 빌트인으로 접근. **프롬프트**는 \`mcp_prompts_to_skills(manager)\`로 스킬 카탈로그에 투영 가능 — 에이전트가 발견 가능한 워크플로로 다룸.

**OAuth**: 장기 서버 (Slack, GitHub 등)는 OAuth가 필요한 경우가 많음. 실행기의 \`McpAuth\` 도구가 전체 authorization-code dance를 실행, 설정된 CredentialStore로 토큰 영속화, 이후 부팅에서 재사용.

**Manifest vs Library**: 이 패널은 환경 스코프 카운트 표시. 실제 서버 정의는 \`manifest.tools.mcp_servers\` (환경별)와 호스트 레벨 admin store (공유 기본값) 양쪽에 저장. 호스트 레벨 기본값 관리는 라이브러리 MCP Servers 탭에서; 환경별 override는 매니페스트 편집으로.`,
  configFields: [
    {
      name: 'manifest.tools.mcp_servers',
      label: 'MCP 서버 정의',
      type: 'list[dict]',
      default: '[]',
      description:
        '서버 항목 리스트. 각각 spawn 방법, 전달할 env 변수, auto-approve 가능한 도구를 기술. 순서는 무관 — 서버는 병렬 부팅.',
    },
    {
      name: 'name',
      label: 'name (항목별)',
      type: 'string',
      required: true,
      description:
        'Stable 식별자. 도구 이름의 prefix로 사용 (예: name="git" → 도구 "git.commit"). 매니페스트 내에서 unique해야 함.',
    },
    {
      name: 'command',
      label: 'command (항목별)',
      type: 'string',
      required: true,
      description:
        'Spawn할 실행 파일. 대부분 npx로 호출되는 Node CLI지만, stdio로 MCP를 말하면 Python / Rust / Go 서버 모두 가능.',
    },
    {
      name: 'args',
      label: 'args (항목별)',
      type: 'list[string]',
      description:
        'Command-line 인자. 예 (filesystem 서버): ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/root"].',
    },
    {
      name: 'env',
      label: 'env (항목별)',
      type: 'dict[string, string]',
      description:
        '서버별 환경 변수. API 토큰과 설정에 사용. 실행기 프로세스 env 위에 상속.',
    },
    {
      name: 'disabled',
      label: 'disabled (항목별)',
      type: 'boolean',
      default: 'false',
      description:
        'true이면 서버 항목 유지하되 부팅 시 건너뜀. 설정 잃지 않고 일시적으로 silencing할 때 유용.',
    },
    {
      name: 'autoApprove',
      label: 'autoApprove (항목별)',
      type: 'list[string]',
      description:
        'HITL 승인을 우회하는 도구 이름 (permission prompt 없음). 신중하게 사용 — 대개 read-only 도구만.',
    },
  ],
  options: [],
  relatedSections: [
    {
      label: 'Executor Built-in: mcp family',
      body: 'MCP / ListMcpResources / ReadMcpResource / McpAuth 도구가 선택되어야 에이전트가 부착된 서버와 실제 상호작용 가능. MCP 서버만 선택하고 이 도구들이 없으면 서버는 부팅되지만 에이전트가 도달 못 함.',
    },
    {
      label: '10단계 — Tools',
      body: '10단계가 빌트인 도구 호출과 동일한 방식으로 MCP 도구 호출도 dispatch — registry는 통합되어 있음.',
    },
    {
      label: '스킬',
      body: 'MCP 프롬프트는 `mcp_prompts_to_skills(manager)`로 스킬 카탈로그에 투영 가능 — 에이전트가 Skill 항목으로 발견.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/mcp/manager.py:MCPManager',
};

export const globalsMcpHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
