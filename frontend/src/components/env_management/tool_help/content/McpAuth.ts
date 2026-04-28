/** Tool detail — McpAuth (executor / mcp family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `McpAuth runs the OAuth 2.0 authorization-code flow against an MCP server that requires it (Slack, GitHub, Google Workspace, etc.). The executor's \`OAuthFlow\` handles the dance: generates a CSRF state, opens a localhost callback HTTP server, sends the user to the authorization URL, exchanges the code for tokens, persists tokens via the configured \`CredentialStore\` under \`mcp:<server>\`.

Subsequent tool calls to that server reuse the persisted tokens automatically — \`McpAuth\` is typically called once per server, not per request. Tokens are refreshed in the background when the server's auth response includes a \`refresh_token\`.

Two flow phases:
  1. **Initiate**: \`McpAuth\` returns the authorization URL. The user opens it in a browser, signs in, approves the requested scopes.
  2. **Complete**: the OAuth provider redirects to the localhost callback with a code; \`OAuthFlow\` exchanges it for tokens and saves them. The agent's tool call returns success.

Headless / non-interactive environments need a different strategy — pre-provision tokens out of band and configure the credential store to load them at boot, rather than relying on McpAuth.`,
  bestFor: [
    'First-time auth setup for OAuth-protected MCP servers',
    'Re-authorising after token revocation or scope changes',
    'Multi-server deployments where each server needs its own OAuth handshake',
  ],
  avoidWhen: [
    'The server uses static API tokens — set them via env / config instead',
    'Headless / batch runs — pre-provision tokens out of band',
    'You already have valid tokens cached — McpAuth would just rotate them unnecessarily',
  ],
  gotchas: [
    'Requires browser access on the same machine as the executor (or a tunneled callback) — purely SSH-headless setups need an alternate flow.',
    'CSRF state is single-use. Restarting the flow mid-handshake invalidates the previous URL.',
    'CredentialStore implementation matters — Memory store loses tokens on restart, File store persists with mode 0600.',
    'Refresh tokens have provider-defined TTL. Long-idle deployments may need to reauthorise.',
  ],
  examples: [
    {
      caption: 'Authorise the github MCP server',
      body: `{
  "server_name": "github"
}`,
      note: 'Returns an authorization URL. After the user approves in-browser, tokens land in CredentialStore at mcp:github.',
    },
  ],
  relatedTools: ['MCP', 'ListMcpResources', 'ReadMcpResource'],
  relatedStages: ['Stage 10 (Tools)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/mcp_auth_tool.py:McpAuthTool + src/geny_executor/auth/oauth.py:OAuthFlow',
};

const ko: ToolDetailContent = {
  body: `McpAuth은 OAuth 2.0 authorization-code flow를 OAuth 필요한 MCP 서버(Slack, GitHub, Google Workspace 등)에 대해 실행합니다. 실행기의 \`OAuthFlow\`가 dance 처리: CSRF state 생성, localhost callback HTTP 서버 오픈, 사용자를 authorization URL로 보냄, 코드를 토큰으로 교환, 설정된 \`CredentialStore\`에 \`mcp:<server>\` 키로 토큰 영속.

해당 서버에 대한 후속 도구 호출은 영속된 토큰 자동 재사용 — \`McpAuth\`는 보통 서버당 한 번 호출, 요청당 아님. 서버 auth 응답에 \`refresh_token\` 포함되면 토큰이 백그라운드에서 갱신됨.

두 flow 단계:
  1. **Initiate**: \`McpAuth\`가 authorization URL 반환. 사용자가 브라우저에서 열어 로그인, 요청된 scope 승인.
  2. **Complete**: OAuth provider가 코드와 함께 localhost callback으로 리다이렉트; \`OAuthFlow\`가 토큰으로 교환하고 저장. 에이전트의 도구 호출이 성공 반환.

헤드리스 / 비인터랙티브 환경은 다른 전략 필요 — McpAuth 의존 대신 토큰을 out of band로 pre-provision하고 부팅 시 로드하도록 credential store 설정.`,
  bestFor: [
    'OAuth 보호 MCP 서버의 첫 auth 설정',
    '토큰 revocation 또는 scope 변경 후 재인증',
    '각 서버가 자체 OAuth handshake 필요한 멀티 서버 배포',
  ],
  avoidWhen: [
    '서버가 정적 API 토큰 사용 — env / config로 대신 설정',
    '헤드리스 / 배치 실행 — out of band로 토큰 pre-provision',
    '이미 유효한 토큰 캐시되어 있는 경우 — McpAuth가 불필요하게 rotate만',
  ],
  gotchas: [
    '실행기와 같은 머신에서 브라우저 액세스 필요(또는 터널된 callback) — 순수 SSH-headless 셋업은 대체 flow 필요.',
    'CSRF state는 single-use. handshake 중 flow 재시작은 이전 URL 무효화.',
    'CredentialStore 구현 중요 — Memory store는 재시작 시 토큰 손실, File store는 mode 0600으로 영속.',
    'Refresh 토큰은 provider 정의 TTL. 장기 idle 배포는 재인증 필요할 수 있음.',
  ],
  examples: [
    {
      caption: 'github MCP 서버 인증',
      body: `{
  "server_name": "github"
}`,
      note: 'authorization URL 반환. 사용자가 in-browser로 승인 후 토큰이 CredentialStore의 mcp:github에 저장.',
    },
  ],
  relatedTools: ['MCP', 'ListMcpResources', 'ReadMcpResource'],
  relatedStages: ['10단계 (Tools)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/mcp_auth_tool.py:McpAuthTool + src/geny_executor/auth/oauth.py:OAuthFlow',
};

export const mcpAuthToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
