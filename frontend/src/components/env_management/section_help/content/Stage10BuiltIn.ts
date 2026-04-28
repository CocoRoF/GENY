/**
 * Help content for Stage 10 → Built-in tools section.
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Framework tools',
  summary:
    "The set of built-in tools the agent is allowed to call. Stored at `manifest.tools.built_in` (a list of names) — the executor's tool registry then exposes only those to Stage 6 / 10.",
  whatItDoes: `Tool selection lives at the **manifest level**, not on Stage 10's stage entry. The list is shared across the whole pipeline — every stage that consults the tool registry sees the same allowed set.

Stage 10 is what actually *executes* tool calls (after the LLM emitted them and Stage 9 parsed them into \`state.pending_tool_calls\`). The tools list here is what Stage 10 is allowed to dispatch to.

The list mirrors the executor's \`BUILT_IN_TOOL_CLASSES\` catalog. Each name corresponds to a Python class registered under the executor's tools package — you pick names, the executor instantiates the classes at pipeline build time.

**The wildcard "Select all"** inherits the entire catalog (whatever the executor library ships in this version). Recommended for general-purpose agents where you want every new tool to become available automatically. For sandboxed or compliance-critical agents, use an explicit list so an executor upgrade doesn't silently grant new capabilities.

**Tool execution rules (Stage 10 details, summarised):**

- Stage 10 walks \`state.pending_tool_calls\` and dispatches each to the registered handler
- Tool input dicts come straight from the LLM via \`tool_use\` blocks — Stage 9 didn't validate them, Stage 10 trusts them
- Tool errors become tool_result blocks with \`is_error: true\` — they don't halt the pipeline
- Stage 4's permission guard runs *before* Stage 10 if it's in the chain, so a blocked tool never reaches dispatch`,
  configFields: [
    {
      name: 'manifest.tools.built_in',
      label: 'Built-in tool names',
      type: 'list[string]',
      default: '[]',
      description:
        'List of tool name strings, or `["*"]` for "all tools in the executor\'s built-in catalog". Empty list = no built-in tools (only MCP tools, if any). Stored at the manifest top level under `tools.built_in`, NOT on Stage 10\'s entry.',
    },
  ],
  options: [],
  relatedSections: [
    {
      label: 'MCP servers (next section in this stage)',
      body: 'MCP tools come from connected Model Context Protocol servers — different mechanism from built-in tools. Both populate the unified tool registry that the LLM sees.',
    },
    {
      label: 'Stage 4 — permission guard',
      body: 'Stage 4\'s `permission` guard provides per-tool allow/block lists *at runtime* — different from selecting which tools the registry contains. Tools must be registered (here) AND not blocked (Stage 4) to reach dispatch.',
    },
    {
      label: 'Stage 11 — Tool review',
      body: 'Stage 11 runs *after* Stage 10\'s dispatch list is decided but before actual execution — it can flag specific calls as needing review. Pair with built-in tools when you want every call audited.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/tools/registry.py:BUILT_IN_TOOL_CLASSES',
};

const ko: SectionHelpContent = {
  title: '프레임워크 도구 (Built-in tools)',
  summary:
    '에이전트가 호출할 수 있는 빌트인 도구 집합. \`manifest.tools.built_in\` (이름 리스트) 에 저장 — 실행기의 tool registry 가 그것들만 6단계 / 10단계에 노출.',
  whatItDoes: `도구 선택은 10단계의 stage entry 가 아닌 **매니페스트 레벨**에 있음. 리스트는 전체 파이프라인에서 공유 — tool registry 를 참조하는 모든 단계가 같은 허용 집합을 봄.

10단계가 실제로 도구 호출을 *실행*하는 곳 (LLM 이 emit 하고 9단계가 \`state.pending_tool_calls\` 로 파싱한 후). 여기 도구 리스트가 10단계가 dispatch 할 수 있는 것.

리스트는 실행기의 \`BUILT_IN_TOOL_CLASSES\` 카탈로그를 미러. 각 이름은 실행기의 tools 패키지에 등록된 Python 클래스에 해당 — 이름을 고르면 실행기가 파이프라인 빌드 시점에 클래스 인스턴스화.

**와일드카드 "Select all"** 은 전체 카탈로그를 상속 (이 버전의 실행기 라이브러리가 ship 하는 모든 것). 새 도구를 자동으로 사용 가능하게 하고 싶은 범용 에이전트에 권장. 샌드박스 또는 컴플라이언스가 critical 한 에이전트는 명시적 리스트 사용 — 실행기 업그레이드가 silent 하게 새 능력을 부여하지 않도록.

**도구 실행 규칙 (10단계 세부, 요약):**

- 10단계가 \`state.pending_tool_calls\` 를 walk 하고 각각을 등록된 핸들러로 dispatch
- 도구 input dict 는 LLM 이 \`tool_use\` 블록으로 바로 전달 — 9단계가 검증 안 함, 10단계가 신뢰
- 도구 에러는 \`is_error: true\` 가 있는 tool_result 블록이 됨 — 파이프라인을 멈추지 않음
- 4단계의 permission guard 가 체인에 있으면 10단계 *전*에 실행, 차단된 도구는 dispatch 에 도달 못 함`,
  configFields: [
    {
      name: 'manifest.tools.built_in',
      label: 'Built-in 도구 이름',
      type: 'list[string]',
      default: '[]',
      description:
        '도구 이름 문자열 리스트, 또는 "실행기의 빌트인 카탈로그의 모든 도구" 를 의미하는 `["*"]`. 빈 리스트 = 빌트인 도구 없음 (MCP 도구만, 있다면). 매니페스트 최상위의 `tools.built_in` 에 저장, 10단계 entry 가 아님.',
    },
  ],
  options: [],
  relatedSections: [
    {
      label: 'MCP 서버 (이 단계의 다음 섹션)',
      body: 'MCP 도구는 연결된 Model Context Protocol 서버에서 옴 — built-in 도구와 다른 메커니즘. 둘 다 LLM 이 보는 통합 tool registry 를 채움.',
    },
    {
      label: '4단계 — permission guard',
      body: '4단계의 `permission` guard 는 *런타임에* 도구별 allow/block 리스트 제공 — registry 가 어떤 도구를 포함하는지 선택하는 것과 다름. 도구는 등록되어 있어야 하고 (여기) AND 차단되지 않아야 (4단계) dispatch 에 도달.',
    },
    {
      label: '11단계 — Tool review',
      body: '11단계는 10단계의 dispatch 리스트 결정 *후*, 실제 실행 전에 실행 — 특정 호출을 review 필요로 플래그 가능. 모든 호출을 감사하고 싶을 때 built-in 도구와 짝.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/tools/registry.py:BUILT_IN_TOOL_CLASSES',
};

export const stage10BuiltInHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
