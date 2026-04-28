/**
 * Help content for Stage 2 → Retriever slot.
 *
 * Source of truth: geny-executor /
 *   src/geny_executor/stages/s02_context/artifact/default/retrievers.py
 *   src/geny_executor/stages/s02_context/artifact/default/stage.py
 *
 * Default registry exposes `null` and `static`. `mcp_resource` lives
 * in the same file but is wired by the host via `attach_runtime`,
 * not via the manifest registry — covered in the gotchas.
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Memory retriever',
  summary:
    "Pulls memory chunks into the prompt. Runs after the strategy reshapes history; uses **the last user message** (not the full history) as its query string.",
  whatItDoes: `After the context strategy finishes trimming \`state.messages\`, Stage 2's \`execute()\` builds a query from the most recent user message and calls the retriever:

\`\`\`
query = (last user message text)
chunks = await self._retriever.retrieve(query, state)
\`\`\`

Returned chunks are deduped by their \`key\` and appended to \`state.memory_refs\`. On the **first iteration only**, the same chunks are also rendered as a multi-line text block at \`state.metadata.memory_context\` — Stage 3 (System) is what actually injects that text into the system prompt.

The retriever is **the legacy memory path**. The unified path is \`MemoryProvider.retrieve(RetrievalQuery)\` — when a host attaches a provider via \`Pipeline.attach_runtime(memory_provider=...)\`, both paths run and chunks are merged after dedup. Pipelines mid-migration keep both working.

**What lives in this slot vs the registry that ships:** \`null\` (default — no retrieval) and \`static\` (returns a fixed list, useful for testing). The host-bound \`MCPResourceRetriever\` (pulls MCP server resources) is a third built-in but it requires a connected MCP manager — it's installed via \`Pipeline.attach_runtime(memory_retriever=MCPResourceRetriever(manager))\`, not by manifest pick.`,
  options: [
    {
      id: 'null',
      label: 'None (no retrieval)',
      description: `Always returns an empty list. The retrieval step is effectively skipped — \`state.memory_refs\` and \`state.metadata.memory_context\` stay untouched by this stage.

This is the default. Pipelines that don't use memory at all, or that delegate retrieval entirely to a host-attached \`MemoryProvider\`, leave the slot here.`,
      bestFor: [
        'Memoryless agents — one-shot tools, classification, anything where conversation continuity is the host\'s problem',
        'Pipelines using `attach_runtime(memory_provider=...)` exclusively — the legacy retriever slot stays `null` while the unified provider does the work',
        'Test pipelines where retrieval would inject non-deterministic content',
      ],
      avoidWhen: [
        'You want some legacy-style retrieval (substring match across MCP resources, static lookup table) but `null` makes that impossible',
      ],
      gotchas: [
        '`null` does NOT prevent the unified `MemoryProvider` path from running. If the host has wired a provider, that retrieval happens regardless of the slot.',
      ],
      codeRef:
        'geny-executor / s02_context/artifact/default/retrievers.py:NullRetriever',
    },
    {
      id: 'static',
      label: 'Static (fixed chunks)',
      description: `Returns a fixed list of \`MemoryChunk\` objects, regardless of the query. The chunks are passed in at construction time via \`StaticRetriever(chunks=[...])\` (Python-side) or appended at runtime via \`add_chunk(key, content, ...)\`.

**The chunks list is NOT runtime-configurable from the manifest** — \`StaticRetriever\` has no \`configure()\`, and the manifest cannot encode \`MemoryChunk\` instances. The slot is useful if a host pre-populates it during pipeline construction; manifest-only configuration leaves it empty (returns \`[]\`).

For test fixtures or documentation injection, host code does:

\`\`\`
ctx_stage = ContextStage()
ctx_stage.set_strategy(
    "retriever", "static",
    config=None,  # ignored
)
ctx_stage._retriever.add_chunk(
    key="readme",
    content="(important reference text)",
    source="static",
)
\`\`\``,
      bestFor: [
        'Test pipelines that need deterministic retrieval output',
        'Demos / documentation agents where always-on reference text should appear in context',
        'Hosts that programmatically construct a small fixed corpus at startup and want it visible every turn',
      ],
      avoidWhen: [
        'You want manifest-only configuration. `static` chunks aren\'t reachable from the manifest — picking it without host-side population is identical to `null`.',
        'Real retrieval against a corpus. Static returns the same chunks for every query, ignoring relevance.',
      ],
      gotchas: [
        '**Picking `static` in the manifest with no host-side `add_chunk` calls behaves exactly like `null`** — the chunks list is empty by default and the manifest can\'t populate it.',
        'Returned chunks always feed into `state.metadata.memory_context` on the first iteration. Stage 3 (System) is what actually renders that into the system prompt — picking `static` without a Stage 3 builder that reads `memory_context` means the chunks land in `state.memory_refs` but don\'t reach the LLM.',
      ],
      codeRef:
        'geny-executor / s02_context/artifact/default/retrievers.py:StaticRetriever',
    },
  ],
  configFields: [],
  relatedSections: [
    {
      label: 'Strategy / Compactor (this stage)',
      body: 'Retrieval runs *after* the strategy trims history but *before* the compactor checks token budget. If your retriever returns large chunks, they may push the running estimate past 80% and trigger compaction on the same turn.',
    },
    {
      label: 'Stage 3 — System',
      body: '`state.metadata.memory_context` (set by the retriever on iteration 0) only reaches the LLM if Stage 3\'s prompt builder reads that key. The composable prompt builder does; the static one does not.',
    },
    {
      label: 'Stage 18 — Memory',
      body: 'Stage 18 is the *write* path; Stage 2\'s retriever is the *read* path. They\'re independent slots — pairing them sensibly (e.g., Stage 18 `reflective` + Stage 2 retriever pointed at the same provider) is what makes a long-lived agent work.',
    },
    {
      label: 'Advanced — `MCPResourceRetriever`',
      body: 'Pulls MCP server resources (the second MCP primitive) as memory chunks. Wired via `Pipeline.attach_runtime(memory_retriever=MCPResourceRetriever(manager))`, not via the manifest registry. If your pipeline uses MCP, this is usually the retriever you actually want.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s02_context/artifact/default/retrievers.py',
};

const ko: SectionHelpContent = {
  title: '메모리 리트리버 (Retriever)',
  summary:
    '메모리 청크를 프롬프트로 끌어오기. 전략이 히스토리를 재구성한 후 실행; **마지막 사용자 메시지** (전체 히스토리가 아닌) 를 쿼리 문자열로 사용.',
  whatItDoes: `컨텍스트 전략이 \`state.messages\` 트리밍을 끝낸 후, 2단계의 \`execute()\` 는 가장 최근 사용자 메시지에서 쿼리를 만들어 retriever 를 호출:

\`\`\`
query = (마지막 user 메시지 텍스트)
chunks = await self._retriever.retrieve(query, state)
\`\`\`

반환된 청크는 \`key\` 로 dedup 되어 \`state.memory_refs\` 에 추가. **첫 iteration 에만** 동일한 청크가 \`state.metadata.memory_context\` 에 multi-line 텍스트 블록으로 렌더 — 그 텍스트를 system prompt 에 실제로 주입하는 것은 3단계 (System).

retriever 는 **레거시 메모리 경로**. 통합 경로는 \`MemoryProvider.retrieve(RetrievalQuery)\` — 호스트가 \`Pipeline.attach_runtime(memory_provider=...)\` 로 provider 를 attach 하면 두 경로가 모두 실행되고 청크가 dedup 후 merge. 마이그레이션 중인 파이프라인은 둘 다 작동.

**이 슬롯에 들어가는 것 vs ship 되는 registry:** \`null\` (기본 — 검색 없음) 과 \`static\` (고정 리스트 반환, 테스트에 유용). 호스트 바인딩되는 \`MCPResourceRetriever\` (MCP 서버 리소스를 가져옴) 는 세 번째 빌트인이지만 연결된 MCP manager 가 필요 — 매니페스트 선택이 아닌 \`Pipeline.attach_runtime(memory_retriever=MCPResourceRetriever(manager))\` 로 설치.`,
  options: [
    {
      id: 'null',
      label: '없음 (None — 검색 없음)',
      description: `항상 빈 리스트 반환. 검색 단계는 사실상 건너뜀 — \`state.memory_refs\` 와 \`state.metadata.memory_context\` 가 이 단계에서 건드려지지 않음.

기본값. 메모리를 전혀 쓰지 않는 파이프라인이나, 검색을 호스트가 attach 한 \`MemoryProvider\` 에 완전히 위임하는 파이프라인은 슬롯을 여기에 둡니다.`,
      bestFor: [
        '메모리리스 에이전트 — 일회성 도구, 분류, 대화 연속성이 호스트의 문제인 모든 것',
        '`attach_runtime(memory_provider=...)` 만 사용하는 파이프라인 — 레거시 retriever 슬롯은 `null` 로 두고 통합 provider 가 일을 함',
        '검색이 비결정적 내용을 주입하면 안 되는 테스트 파이프라인',
      ],
      avoidWhen: [
        '레거시 스타일 검색 (MCP 리소스 substring 매칭, 정적 lookup table) 을 원할 때 — `null` 은 그것을 불가능하게 만듦',
      ],
      gotchas: [
        '`null` 이 통합 `MemoryProvider` 경로를 막지 않습니다. 호스트가 provider 를 wire 했다면 슬롯과 무관하게 그 검색이 일어납니다.',
      ],
      codeRef:
        'geny-executor / s02_context/artifact/default/retrievers.py:NullRetriever',
    },
    {
      id: 'static',
      label: '정적 (Static — 고정 청크)',
      description: `쿼리와 무관하게 고정 \`MemoryChunk\` 객체 리스트 반환. 청크는 생성 시점에 \`StaticRetriever(chunks=[...])\` (Python 측) 로 전달되거나 런타임에 \`add_chunk(key, content, ...)\` 로 추가.

**청크 리스트는 매니페스트에서 런타임 구성 불가** — \`StaticRetriever\` 에 \`configure()\` 없음, 매니페스트는 \`MemoryChunk\` 인스턴스를 인코딩 못 함. 호스트가 파이프라인 구성 시점에 미리 채우면 유용; 매니페스트 전용 구성은 비어있는 채로 둠 (\`[]\` 반환).

테스트 fixture 나 문서 주입을 위해, 호스트 코드는:

\`\`\`
ctx_stage = ContextStage()
ctx_stage.set_strategy(
    "retriever", "static",
    config=None,  # 무시됨
)
ctx_stage._retriever.add_chunk(
    key="readme",
    content="(중요 참고 텍스트)",
    source="static",
)
\`\`\``,
      bestFor: [
        '결정적 검색 출력이 필요한 테스트 파이프라인',
        '항상-켜진 참고 텍스트가 컨텍스트에 나타나야 하는 데모 / 문서 에이전트',
        '시작 시 작은 고정 corpus 를 프로그래밍 방식으로 구성하고 매 턴 보이게 하고 싶은 호스트',
      ],
      avoidWhen: [
        '매니페스트 전용 구성을 원할 때. `static` 청크는 매니페스트로 도달 불가 — 호스트 측 채움 없이 선택하는 것은 `null` 과 동일.',
        'corpus 에 대한 실제 검색. Static 은 모든 쿼리에 같은 청크 반환, relevance 무시.',
      ],
      gotchas: [
        '**호스트 측 `add_chunk` 호출 없이 매니페스트에서 `static` 을 선택하는 것은 정확히 `null` 과 동일하게 동작** — 청크 리스트는 기본적으로 비어있고 매니페스트가 채울 수 없음.',
        '반환된 청크는 항상 첫 iteration 에 `state.metadata.memory_context` 로 들어감. 그것을 system prompt 에 실제로 렌더하는 것은 3단계 (System) — `memory_context` 를 읽는 3단계 builder 없이 `static` 을 선택하면 청크가 `state.memory_refs` 에는 도달하지만 LLM 에는 도달하지 않음.',
      ],
      codeRef:
        'geny-executor / s02_context/artifact/default/retrievers.py:StaticRetriever',
    },
  ],
  configFields: [],
  relatedSections: [
    {
      label: '전략 / 압축기 (이 단계)',
      body: '검색은 strategy 가 히스토리를 trim 한 *후*, compactor 가 토큰 예산을 체크하기 *전*에 실행. retriever 가 큰 청크를 반환하면 추정치가 80% 를 넘어 같은 턴에 압축이 trigger 될 수 있음.',
    },
    {
      label: '3단계 — System',
      body: '`state.metadata.memory_context` (retriever 가 iteration 0 에 설정) 는 3단계의 prompt builder 가 그 키를 읽을 때만 LLM 에 도달. composable prompt builder 는 읽고; static 은 읽지 않음.',
    },
    {
      label: '18단계 — Memory',
      body: '18단계는 *write* 경로; 2단계의 retriever 는 *read* 경로. 독립 슬롯 — 합리적으로 짝짓기 (예: 18단계 `reflective` + 2단계 retriever 가 같은 provider 가리키기) 가 장기 에이전트를 작동하게 만드는 것.',
    },
    {
      label: 'Advanced — `MCPResourceRetriever`',
      body: 'MCP 서버 리소스 (두 번째 MCP primitive) 를 메모리 청크로 가져옴. 매니페스트 registry 가 아닌 `Pipeline.attach_runtime(memory_retriever=MCPResourceRetriever(manager))` 로 wire. 파이프라인이 MCP 를 사용한다면 보통 이것이 실제로 원하는 retriever.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s02_context/artifact/default/retrievers.py',
};

export const stage02RetrieverHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
