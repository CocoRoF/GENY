/** Tool detail — ReadMcpResource (executor / mcp family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `ReadMcpResource fetches the content of an MCP resource by its \`mcp://\` URI. Supports cross-server reads — \`mcp://server-a/...\` works regardless of which server owns the URI as long as that server is connected.

Resources can be:
  - Text payloads (returned as the content directly)
  - Binary payloads (base64-encoded; the agent must decode if it needs raw bytes)
  - Structured records (JSON or other server-defined formats)

The response shape: \`{contents: [{uri, mime_type, text?, blob?}]}\`. Servers may return multiple parts for a single URI (e.g., a directory listing, a multi-part document).

When a resource doesn't exist or the server is offline, the tool returns an error rather than empty content. Treat errors as "the resource isn't currently readable" — don't assume it never existed.`,
  bestFor: [
    'Reading a known MCP resource by URI',
    'Following up on a ListMcpResources entry',
    'Cross-server resource access (the URI scheme handles routing)',
  ],
  avoidWhen: [
    'You don\'t have a URI yet — call ListMcpResources first or query the right server\'s search tool',
    'The resource is huge — many MCP servers don\'t paginate; consider whether the agent really needs the full payload',
  ],
  gotchas: [
    'The response may contain multiple parts for a single URI — check `contents` length.',
    'Binary payloads come as base64; large blobs can blow the context window.',
    'mime_type is the server\'s claim, not validated. Treat it as a hint.',
    'A read counts as a stateful interaction with the server — for OAuth\'d servers, it consumes the same auth budget as tool calls.',
  ],
  examples: [
    {
      caption: 'Read a specific file via the filesystem server',
      body: `{
  "uri": "mcp://filesystem/data/report.md"
}`,
      note: 'Returns the file\'s text content (or base64 if binary) under contents[0].text or contents[0].blob.',
    },
  ],
  relatedTools: ['ListMcpResources', 'MCP', 'McpAuth'],
  relatedStages: ['Stage 10 (Tools)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/read_mcp_resource_tool.py:ReadMcpResourceTool',
};

const ko: ToolDetailContent = {
  body: `ReadMcpResource는 \`mcp://\` URI로 MCP 리소스의 콘텐츠를 fetch합니다. Cross-server 읽기 지원 — 그 서버가 연결되어 있는 한 \`mcp://server-a/...\`은 URI를 소유한 서버와 무관하게 작동.

리소스는:
  - 텍스트 페이로드(콘텐츠로 직접 반환)
  - 바이너리 페이로드(base64 인코딩; 원시 바이트 필요 시 에이전트가 디코드)
  - 구조화 레코드(JSON 또는 서버 정의 포맷)

응답 형태: \`{contents: [{uri, mime_type, text?, blob?}]}\`. 서버가 단일 URI에 대해 여러 부분 반환 가능(예: 디렉토리 리스팅, 멀티파트 문서).

리소스가 존재하지 않거나 서버가 오프라인이면 도구가 빈 콘텐츠 대신 에러 반환. 에러는 "현재 읽을 수 없음"으로 취급 — 절대 존재하지 않았다고 가정 금지.`,
  bestFor: [
    'URI로 알려진 MCP 리소스 읽기',
    'ListMcpResources 항목 follow-up',
    'Cross-server 리소스 액세스(URI 스키마가 라우팅 처리)',
  ],
  avoidWhen: [
    'URI 아직 없음 — 먼저 ListMcpResources 호출 또는 적절한 서버의 검색 도구 쿼리',
    '리소스가 거대할 때 — 많은 MCP 서버가 페이지네이션 안 함; 풀 페이로드가 정말 필요한지 검토',
  ],
  gotchas: [
    '응답이 단일 URI에 대해 여러 부분 포함 가능 — `contents` 길이 확인.',
    '바이너리 페이로드는 base64; 큰 blob은 컨텍스트 창 폭발 위험.',
    'mime_type은 서버의 주장, 검증 안 됨. hint로 취급.',
    'read는 서버와 stateful 상호작용 카운트 — OAuth 서버는 도구 호출과 같은 auth 예산 소비.',
  ],
  examples: [
    {
      caption: 'filesystem 서버로 특정 파일 읽기',
      body: `{
  "uri": "mcp://filesystem/data/report.md"
}`,
      note: '파일의 텍스트 콘텐츠(또는 바이너리면 base64)를 contents[0].text 또는 contents[0].blob에 반환.',
    },
  ],
  relatedTools: ['ListMcpResources', 'MCP', 'McpAuth'],
  relatedStages: ['10단계 (Tools)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/read_mcp_resource_tool.py:ReadMcpResourceTool',
};

export const readMcpResourceToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
