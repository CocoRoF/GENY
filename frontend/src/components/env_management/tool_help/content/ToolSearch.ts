/** Tool detail — ToolSearch (executor / meta family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `ToolSearch is the discovery tool. It searches the unified tool registry (executor built-ins + Geny tools + MCP) by capability or keyword and returns matches with full schemas. The agent uses it when it knows what it wants to do but not which tool to call.

Two query modes:
  - Keyword: free-text search over tool names + descriptions
  - Capability: structured filter — \`read_only=true\`, \`destructive=false\`, etc.

Returns a list of \`{name, description, capabilities, input_schema}\`. The agent then calls the matched tool directly; ToolSearch is read-only.

This is one of the core meta-cognition tools — it lets the agent operate on a large catalog without hard-coding tool names. Pair it with EnterPlanMode for "show me what's available, then pick" workflows.`,
  bestFor: [
    'Large environments where the agent doesn\'t know every available tool name',
    'Capability-driven discovery ("any read-only tool that touches the filesystem")',
    'Plan-then-execute flows where the agent surveys before choosing',
  ],
  avoidWhen: [
    'You already know the exact tool name — call it directly',
    'You need to enumerate the entire catalog — Geny\'s manifest editor surfaces it',
  ],
  gotchas: [
    'Returns descriptions, not the live tool. The agent still needs to call the matched tool to do work.',
    'Capability filters are AND. Multiple constraints narrow aggressively.',
    'Ranking is by name match → description match → capability match. Pure capability queries return alphabetical order.',
  ],
  examples: [
    {
      caption: 'Find a read-only tool to inspect files',
      body: `{
  "query": "inspect file content",
  "capabilities": {"read_only": true}
}`,
      note: 'Returns Read, Grep, Glob etc. — the agent picks one and calls it next turn.',
    },
  ],
  relatedTools: ['Agent', 'EnterPlanMode'],
  relatedStages: ['Stage 10 (Tools)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/tool_search_tool.py:ToolSearchTool',
};

const ko: ToolDetailContent = {
  body: `ToolSearch는 발견(discovery) 도구. capability나 키워드로 통합 tool registry(executor 빌트인 + Geny + MCP)를 검색해 풀 스키마와 함께 매칭을 반환합니다. 에이전트가 "뭘 해야 할지"는 알지만 "어떤 도구를 호출할지" 모를 때 사용.

두 query 모드:
  - 키워드: 도구 이름 + 설명에 대한 free-text 검색
  - Capability: 구조화 필터 — \`read_only=true\`, \`destructive=false\` 등

\`{name, description, capabilities, input_schema}\` 리스트 반환. 그 후 에이전트가 매칭된 도구를 직접 호출; ToolSearch 자체는 read-only.

핵심 meta-cognition 도구 중 하나 — 도구 이름을 hard-code 하지 않고도 에이전트가 큰 카탈로그를 다룰 수 있게 함. EnterPlanMode와 짝을 이루어 "사용 가능한 것 보여줘 → 골라" 워크플로 구현.`,
  bestFor: [
    '에이전트가 모든 사용 가능한 도구 이름을 모르는 큰 환경',
    'Capability 기반 발견("파일시스템을 건드리는 read-only 도구 찾기")',
    'Plan-then-execute 흐름에서 선택 전 survey',
  ],
  avoidWhen: [
    '정확한 도구 이름을 이미 아는 경우 — 직접 호출',
    '전체 카탈로그를 enumerate해야 하는 경우 — Geny 매니페스트 에디터가 표면화',
  ],
  gotchas: [
    '설명 반환, 라이브 도구 아님. 에이전트가 작업하려면 매칭된 도구를 여전히 호출해야 함.',
    'Capability 필터는 AND. 여러 제약은 공격적으로 좁힘.',
    '랭킹: 이름 매칭 → 설명 매칭 → capability 매칭. 순수 capability 쿼리는 알파벳 순.',
  ],
  examples: [
    {
      caption: '파일 검사용 read-only 도구 찾기',
      body: `{
  "query": "inspect file content",
  "capabilities": {"read_only": true}
}`,
      note: 'Read, Grep, Glob 등 반환 — 에이전트가 하나 골라 다음 턴에 호출.',
    },
  ],
  relatedTools: ['Agent', 'EnterPlanMode'],
  relatedStages: ['10단계 (Tools)'],
  codeRef:
    'geny-executor / src/geny_executor/tools/built_in/tool_search_tool.py:ToolSearchTool',
};

export const toolSearchToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
