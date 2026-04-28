/**
 * Help content for Globals → Geny Built-in Tool panel.
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Geny built-in tools',
  summary:
    'Tools advertised by `GenyToolProvider` — host-side capabilities that the Geny backend wires into the executor at session start. Separate from the executor\'s own `BUILT_IN_TOOL_CLASSES` catalog. Selected names land in `manifest.tools.external`.',
  whatItDoes: `geny-executor exposes a \`ToolProvider\` Protocol (since 0.35.0); a host can register its own provider that advertises additional tools. Geny ships a \`GenyToolProvider\` that surfaces:

- **Custom Python tools** dropped into \`backend/tools/custom/\` — auto-discovered at boot, exposed by name.
- **Geny-flavoured wrappers** around platform features (e.g., session memory access, Geny-side artifact storage).
- Anything else the backend wants the agent to be able to call without the executor knowing about it.

The provider is queried by name at session boot. Names listed in \`manifest.tools.external\` are attached to the \`AgentSession\`'s tool registry alongside whatever \`tools.built_in\` selected. Names missing from the catalog are dropped silently — adding a new tool means dropping the file and refreshing this picker.

**Why two catalogs?** \`tools.built_in\` (executor) is what ships with the library; bumping geny-executor releases new entries. \`tools.external\` (Geny) is what *this deployment* adds — host-specific, repo-specific, or experimental tools that don't belong upstream. Splitting them means a deployment can disable executor tools wholesale (\`tools.built_in: []\`) while keeping its own custom tools active.

**Catalog source**: \`/api/tools/catalog/external\` — the backend introspects \`GenyToolProvider.list_names()\` and returns a flat list with \`{name, category, description}\`.

**Categories**: the backend can group external tools by source (\`built_in\` for first-party Geny additions, \`custom\` for files in \`backend/tools/custom\`, etc.) — purely for UI organisation, no semantic effect on dispatch.`,
  configFields: [
    {
      name: 'manifest.tools.external',
      label: 'Geny tool names',
      type: 'list[string]',
      default: '[]',
      description:
        'Names from `GenyToolProvider.list_names()` to attach to the agent session. Names not present in the catalog at session boot are dropped without error.',
    },
  ],
  options: [],
  relatedSections: [
    {
      label: 'Executor Built-in tools (previous tab)',
      body: 'The 38 tools shipped with the geny-executor library. Independent catalog and manifest field. Both populate the unified registry the agent sees.',
    },
    {
      label: 'MCP (next tab)',
      body: 'MCP is yet another tool source — Model Context Protocol servers attach external processes that advertise tools at runtime. Three independent catalogs (executor / Geny / MCP) merged into one registry per session.',
    },
    {
      label: 'Stage 4 — Permission guard',
      body: 'Geny tools are subject to the same allow/deny rules as executor tools. A deny match blocks dispatch regardless of which catalog the tool came from.',
    },
  ],
  codeRef:
    'Geny / backend/tools/custom/ + backend/controller/tool_controller.py::get_external_tools',
};

const ko: SectionHelpContent = {
  title: 'Geny 빌트인 도구',
  summary:
    '`GenyToolProvider`가 광고하는 도구 — Geny 백엔드가 세션 시작 시 실행기에 와이어업하는 호스트 측 능력. 실행기 자체의 `BUILT_IN_TOOL_CLASSES` 카탈로그와 별개. 선택된 이름이 `manifest.tools.external`에 들어갑니다.',
  whatItDoes: `geny-executor는 \`ToolProvider\` Protocol을 노출 (0.35.0+); 호스트가 자체 provider를 등록해 추가 도구를 광고할 수 있습니다. Geny는 \`GenyToolProvider\`를 ship하며 다음을 노출:

- **커스텀 파이썬 도구** \`backend/tools/custom/\`에 추가된 것 — 부팅 시 자동 발견, 이름으로 노출.
- **Geny 플레이버 wrapper** 플랫폼 기능 (세션 메모리 접근, Geny 측 아티팩트 저장 등)에 대한 래퍼.
- 그 외 백엔드가 실행기에게 알리지 않고 에이전트가 호출하길 원하는 모든 것.

provider는 세션 부팅 시 이름으로 조회됩니다. \`manifest.tools.external\`에 나열된 이름이 \`AgentSession\`의 tool registry에 \`tools.built_in\`이 선택한 것들과 함께 부착. 카탈로그에 없는 이름은 silent하게 drop — 새 도구 추가는 파일 drop 후 이 picker 새로고침이면 끝.

**왜 두 카탈로그?** \`tools.built_in\` (실행기)은 라이브러리와 함께 ship되는 것; geny-executor 업그레이드가 새 항목을 가져옴. \`tools.external\` (Geny)은 *이 배포*가 추가하는 것 — host-specific, repo-specific, 또는 upstream에 속하지 않는 실험적 도구. 분리하면 배포가 실행기 도구 전체를 끄고 (\`tools.built_in: []\`) 자체 커스텀 도구만 활성 유지 가능.

**카탈로그 소스**: \`/api/tools/catalog/external\` — 백엔드가 \`GenyToolProvider.list_names()\`를 introspection하고 \`{name, category, description}\` 평면 리스트 반환.

**카테고리**: 백엔드가 외부 도구를 출처별로 그루핑 가능 (\`built_in\`은 first-party Geny 추가, \`custom\`은 \`backend/tools/custom\` 파일 등) — 순수 UI 조직용, dispatch에 의미적 영향 없음.`,
  configFields: [
    {
      name: 'manifest.tools.external',
      label: 'Geny 도구 이름',
      type: 'list[string]',
      default: '[]',
      description:
        '에이전트 세션에 부착할 `GenyToolProvider.list_names()`에서 가져온 이름들. 세션 부팅 시 카탈로그에 없는 이름은 에러 없이 drop.',
    },
  ],
  options: [],
  relatedSections: [
    {
      label: 'Executor Built-in tools (이전 탭)',
      body: 'geny-executor 라이브러리와 함께 ship되는 38개 도구. 독립 카탈로그와 매니페스트 필드. 둘 다 에이전트가 보는 통합 registry를 채움.',
    },
    {
      label: 'MCP (다음 탭)',
      body: 'MCP는 또 다른 도구 소스 — Model Context Protocol 서버가 런타임에 도구를 광고하는 외부 프로세스를 부착. 세 개의 독립 카탈로그 (executor / Geny / MCP)가 세션당 하나의 registry로 병합.',
    },
    {
      label: '4단계 — Permission guard',
      body: 'Geny 도구도 executor 도구와 같은 allow/deny 규칙 대상. deny 매칭은 카탈로그 출처와 무관하게 dispatch 차단.',
    },
  ],
  codeRef:
    'Geny / backend/tools/custom/ + backend/controller/tool_controller.py::get_external_tools',
};

export const globalsGenyToolsHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
