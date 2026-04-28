/** Tool detail — ListMcpResources (executor / mcp family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `ListMcpResources enumerates the resources advertised by connected MCP servers. Resources are read-only data — files, DB rows, structured records — exposed via the Model Context Protocol. They live alongside tools but with a different access pattern: tools are invoked, resources are read.

The response includes \`{uri, name, description, mime_type}\` for each resource. The URIs use the \`mcp://\` scheme (e.g., \`mcp://filesystem/path/to/file\`) and become inputs to ReadMcpResource. Cross-server URIs work as long as the server name in the URI matches a connected server.

Optionally filter by \`server_name\` to scope the listing to a single server — useful when the catalog is large.

Resource counts can be large (filesystem servers often expose hundreds of paths). Plan to filter / search rather than list everything when the catalog is rich.`,
  bestFor: [
    'Discovering what data an MCP server exposes',
    'Building a candidate list before ReadMcpResource',
    'Inspecting which servers actually advertise resources (some only expose tools)',
  ],
  avoidWhen: [
    'You already know the resource URI — call ReadMcpResource directly',
    'You\'re looking for tools — those are in the tool registry, not resources',
  ],
  gotchas: [
    'Resources can disappear between list and read — they\'re live (filesystem servers may have files deleted, DB servers may have rows removed).',
    'Large catalogs return long responses. Filter by server_name first to scope.',
    'Resource names aren\'t guaranteed unique across servers. Always use the full URI to disambiguate.',
  ],
  examples: [
    {
      caption: 'List resources from the filesystem server',
      body: `{
  "server_name": "filesystem"
}`,
      note: 'Returns a list of {uri, name, description, mime_type} for that server only.',
    },
  ],
  relatedTools: ['ReadMcpResource', 'MCP', 'McpAuth'],
  relatedStages: ['Stage 10 (Tools)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/list_mcp_resources_tool.py:ListMcpResourcesTool',
};

const ko: ToolDetailContent = {
  body: `ListMcpResources는 연결된 MCP 서버가 광고하는 리소스를 enumerate합니다. 리소스는 read-only 데이터 — 파일, DB 행, 구조화된 레코드 — Model Context Protocol로 노출됨. 도구와 같은 위치에 있지만 다른 액세스 패턴: 도구는 invoke, 리소스는 read.

응답은 각 리소스에 대해 \`{uri, name, description, mime_type}\` 포함. URI는 \`mcp://\` 스키마 사용(예: \`mcp://filesystem/path/to/file\`) — ReadMcpResource의 입력. URI의 서버 이름이 연결된 서버와 매칭되는 한 cross-server URI 작동.

선택적으로 \`server_name\`으로 필터링해 단일 서버로 listing 범위 제한 — 카탈로그가 클 때 유용.

리소스 카운트가 클 수 있음(filesystem 서버는 종종 수백 개 경로 노출). 리치한 카탈로그일 때는 전체 list 대신 필터 / 검색 계획.`,
  bestFor: [
    'MCP 서버가 노출하는 데이터 발견',
    'ReadMcpResource 전 후보 리스트 구축',
    '실제로 리소스 광고하는 서버 검사(일부는 도구만 노출)',
  ],
  avoidWhen: [
    '리소스 URI 이미 아는 경우 — ReadMcpResource 직접 호출',
    '도구 찾는 경우 — 그건 tool registry에, 리소스 아님',
  ],
  gotchas: [
    '리소스는 list와 read 사이에 사라질 수 있음 — 라이브(filesystem 서버는 파일 삭제될 수 있고, DB 서버는 행 제거될 수 있음).',
    '큰 카탈로그는 긴 응답 반환. 먼저 server_name으로 범위 제한.',
    '리소스 이름은 서버 간 unique 보장 안 됨. 항상 풀 URI로 disambiguate.',
  ],
  examples: [
    {
      caption: 'filesystem 서버의 리소스 list',
      body: `{
  "server_name": "filesystem"
}`,
      note: '해당 서버만의 {uri, name, description, mime_type} 리스트 반환.',
    },
  ],
  relatedTools: ['ReadMcpResource', 'MCP', 'McpAuth'],
  relatedStages: ['10단계 (Tools)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/list_mcp_resources_tool.py:ListMcpResourcesTool',
};

export const listMcpResourcesToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
