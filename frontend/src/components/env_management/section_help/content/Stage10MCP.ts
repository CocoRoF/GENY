/**
 * Help content for Stage 10 → MCP servers section.
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'MCP servers',
  summary:
    "Connected Model Context Protocol servers. Each server contributes its own set of tools to the unified registry — agents call them by name just like built-ins.",
  whatItDoes: `MCP servers are external processes (or services) that expose tools via the Model Context Protocol. The Geny app connects to them out-of-band (the **MCP Servers** tab handles add / edit / connect) — Stage 10's view here is **read-only** with a cross-link to the management surface.

When an MCP server is connected, its tools join \`state.tools\` alongside built-ins. From the LLM's point of view they look the same — same JSON tool schema, same tool_use mechanism. Stage 10 dispatches to them via the MCP protocol when the agent calls them.

**What this section is for:** confirming the MCP servers attached to this pipeline, in this snapshot. The list is a snapshot of what was connected at manifest-snapshot time — adding a new MCP server later doesn't auto-attach it; you'd need to update the manifest.

**Why this is a separate concern from built-ins:**

- Built-in tools come from the executor library — the same set every time you start a pipeline with that executor version
- MCP tools come from external processes — depend on those processes being running and reachable
- Connection failures are handled at Stage 10 dispatch time (errors become \`is_error: true\` tool_results), not at manifest-load time
- Schema is *discovered* at connect time via MCP's \`list_tools\` — the manifest doesn't pin tool schemas, just server identities`,
  options: [],
  relatedSections: [
    {
      label: 'Built-in tools (previous section in this stage)',
      body: 'Built-ins are named statically in the manifest. MCP tools are *discovered* from connected servers — different lifecycles.',
    },
    {
      label: 'MCP Servers tab (top-level navigation)',
      body: 'Add / edit / connect / disconnect MCP servers there. Stage 10\'s view is read-only — it reflects the current connection set.',
    },
    {
      label: 'Stage 2 — MCPResourceRetriever',
      body: 'MCP servers also expose **resources** (the second MCP primitive) — different from tools. Stage 2\'s host-attachable `MCPResourceRetriever` pulls those into context. Tools = active calls; resources = passive context.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/tools/mcp/manager.py',
};

const ko: SectionHelpContent = {
  title: 'MCP 서버',
  summary:
    '연결된 Model Context Protocol 서버. 각 서버가 통합 registry 에 자체 도구 집합 기여 — 에이전트가 빌트인처럼 이름으로 호출.',
  whatItDoes: `MCP 서버는 Model Context Protocol 로 도구를 노출하는 외부 프로세스 (또는 서비스). Geny 앱이 out-of-band 로 연결 (**MCP Servers** 탭이 추가 / 편집 / 연결 처리) — 10단계의 여기 뷰는 관리 surface 로의 cross-link 가 있는 **읽기 전용**.

MCP 서버가 연결되면 그 도구들이 빌트인과 함께 \`state.tools\` 에 합류. LLM 입장에서 같아 보임 — 같은 JSON 도구 스키마, 같은 tool_use 메커니즘. 10단계가 에이전트가 호출하면 MCP 프로토콜로 dispatch.

**이 섹션이 무엇에 쓰는가:** 이 스냅샷의 이 파이프라인에 attach 된 MCP 서버 확인. 리스트는 매니페스트 스냅샷 시점에 연결된 것의 스냅샷 — 나중에 새 MCP 서버 추가는 자동 attach 안 됨; 매니페스트 업데이트 필요.

**왜 빌트인과 별개 관심사인가:**

- 빌트인 도구는 실행기 라이브러리에서 옴 — 그 실행기 버전으로 파이프라인 시작할 때마다 같은 집합
- MCP 도구는 외부 프로세스에서 옴 — 그 프로세스가 실행 중이고 도달 가능해야 함에 의존
- 연결 실패는 매니페스트 로드 시점이 아닌 10단계 dispatch 시점에 처리 (에러는 \`is_error: true\` tool_results 가 됨)
- 스키마는 MCP 의 \`list_tools\` 로 연결 시점에 *discovered* — 매니페스트가 도구 스키마를 고정하지 않음, 서버 신원만`,
  options: [],
  relatedSections: [
    {
      label: 'Built-in 도구 (이 단계의 이전 섹션)',
      body: '빌트인은 매니페스트에 정적으로 명명. MCP 도구는 연결된 서버에서 *discovered* — 다른 lifecycle.',
    },
    {
      label: 'MCP Servers 탭 (탑 레벨 네비게이션)',
      body: '거기서 MCP 서버 추가 / 편집 / 연결 / 연결 해제. 10단계의 뷰는 읽기 전용 — 현재 연결 집합 반영.',
    },
    {
      label: '2단계 — MCPResourceRetriever',
      body: 'MCP 서버는 **resources** 도 노출 (두 번째 MCP primitive) — 도구와 다름. 2단계의 호스트 attachable `MCPResourceRetriever` 가 그것을 컨텍스트로 가져옴. 도구 = 활성 호출; 리소스 = 수동 컨텍스트.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/tools/mcp/manager.py',
};

export const stage10MCPHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
