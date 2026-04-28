/** Tool detail — MCP (executor / mcp family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `MCP is the dispatcher for Model Context Protocol tools. Each connected MCP server advertises its own toolset at boot — \`MCPManager\` registers them in the unified tool registry with the server name as a prefix (\`server_name.tool_name\`). The agent calls them like any built-in tool; the dispatcher routes the call to the right subprocess via stdio.

The \`MCP\` tool itself isn't usually called directly — it's the umbrella under which prefixed names like \`filesystem.read_file\` or \`git.commit\` appear. The dispatcher handles arg serialisation, response parsing, and error translation so the LLM sees a uniform schema regardless of the server's transport.

When a server returns an error, the dispatcher converts it into a \`tool_result\` with \`is_error: true\` — the agent can adjust and retry. Server crashes are also surfaced as errors; \`MCPManager\` attempts a respawn for the next call (configurable per server).

Tool arguments use the schema the server advertised. Validation happens at the dispatcher: required fields missing → tool error before any subprocess call. The agent sees the schema via ToolSearch / catalog inspection, same as any other tool.`,
  bestFor: [
    'Calling tools advertised by an MCP server (the most common path)',
    'Servers with their own native ecosystems (filesystem, git, slack, github, etc.)',
    'Cross-server orchestration where the dispatcher handles routing',
  ],
  avoidWhen: [
    'A direct executor built-in does the same job — it\'s lower latency and skips the IPC',
    'You haven\'t added the server to manifest.tools.mcp_servers — call will fail with "server not registered"',
  ],
  gotchas: [
    'Tool names are prefixed with server name. Agents that don\'t know about this prefix call the wrong (or non-existent) tool.',
    'Server boot is parallel but not instant — the first tool call after session start may queue briefly.',
    'A crashing server affects only its own tools; other servers continue. But its tools fail until respawn succeeds.',
    'Some MCP servers return rich content blocks (images, resources). The dispatcher passes them through; the LLM must handle non-text payloads.',
  ],
  examples: [
    {
      caption: 'Read a file via the filesystem MCP server',
      body: `{
  "tool_name": "filesystem.read_file",
  "arguments": {"path": "/data/notes.md"}
}`,
      note: 'Dispatcher routes to the filesystem server\'s read_file handler; response flows back as a tool_result.',
    },
  ],
  relatedTools: ['ListMcpResources', 'ReadMcpResource', 'McpAuth'],
  relatedStages: ['Stage 10 (Tools)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/mcp_tool.py:MCPTool + src/geny_executor/mcp/manager.py:MCPManager',
};

const ko: ToolDetailContent = {
  body: `MCP는 Model Context Protocol 도구의 dispatcher. 연결된 각 MCP 서버가 부팅 시 자체 toolset을 광고 — \`MCPManager\`가 서버 이름을 prefix로 통합 tool registry에 등록(\`server_name.tool_name\`). 에이전트는 빌트인 도구처럼 호출; dispatcher가 호출을 stdio 통해 올바른 서브프로세스로 라우팅.

\`MCP\` 도구 자체는 보통 직접 호출되지 않음 — \`filesystem.read_file\`이나 \`git.commit\` 같은 prefix된 이름이 등장하는 우산 역할. dispatcher가 인자 직렬화, 응답 파싱, 에러 변환 처리 — LLM은 서버의 transport와 무관하게 통일된 스키마를 봄.

서버가 에러 반환 시 dispatcher가 \`is_error: true\`인 \`tool_result\`로 변환 — 에이전트가 조정 후 재시도 가능. 서버 크래시도 에러로 표면화; \`MCPManager\`가 다음 호출에 respawn 시도(서버별 설정 가능).

도구 인자는 서버가 광고한 스키마 사용. 검증은 dispatcher에서: 필수 필드 누락 → 서브프로세스 호출 전에 도구 에러. 에이전트는 ToolSearch / 카탈로그 검사로 다른 도구처럼 스키마 확인.`,
  bestFor: [
    'MCP 서버가 광고한 도구 호출(가장 흔한 경로)',
    '자체 native 생태계가 있는 서버(filesystem, git, slack, github 등)',
    'dispatcher가 라우팅 처리하는 cross-server 오케스트레이션',
  ],
  avoidWhen: [
    'executor 빌트인이 같은 일을 하는 경우 — 지연 짧고 IPC skip',
    'manifest.tools.mcp_servers에 서버 추가하지 않은 경우 — "server not registered"로 실패',
  ],
  gotchas: [
    '도구 이름이 서버 이름으로 prefix됨. prefix 모르는 에이전트는 잘못된(또는 존재하지 않는) 도구 호출.',
    '서버 부팅은 병렬이지만 즉시는 아님 — 세션 시작 후 첫 도구 호출은 잠시 queue될 수 있음.',
    '크래시 서버는 자신의 도구만 영향; 다른 서버는 계속. 하지만 respawn 성공까지 그 서버의 도구는 실패.',
    '일부 MCP 서버는 rich content 블록(이미지, 리소스) 반환. dispatcher가 통과시키며, LLM이 non-text 페이로드 처리해야 함.',
  ],
  examples: [
    {
      caption: 'filesystem MCP 서버로 파일 읽기',
      body: `{
  "tool_name": "filesystem.read_file",
  "arguments": {"path": "/data/notes.md"}
}`,
      note: 'dispatcher가 filesystem 서버의 read_file 핸들러로 라우팅; 응답이 tool_result로 흐름.',
    },
  ],
  relatedTools: ['ListMcpResources', 'ReadMcpResource', 'McpAuth'],
  relatedStages: ['10단계 (Tools)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/mcp_tool.py:MCPTool + src/geny_executor/mcp/manager.py:MCPManager',
};

export const mcpToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
