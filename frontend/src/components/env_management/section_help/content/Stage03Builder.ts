/**
 * Help content for Stage 3 → Builder slot.
 *
 * Source of truth: geny-executor /
 *   src/geny_executor/stages/s03_system/artifact/default/builders.py
 *   src/geny_executor/stages/s03_system/artifact/default/stage.py
 *   src/geny_executor/stages/s03_system/persona/builder.py
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Prompt builder',
  summary:
    "Decides how the **system prompt** is constructed each turn. Output goes to `state.system` — what Stage 6 (API) eventually ships to the LLM as the `system` parameter.",
  whatItDoes: `Stage 3 has one slot (\`builder\`) and writes one thing (\`state.system\`). It runs synchronously after Stage 2 (Context) and before Stage 4 (Guard).

The builder takes \`PipelineState\` and returns either a plain string or a list of Anthropic-style content blocks. The choice of builder decides:

- **What goes into the prompt** — fixed text, composed blocks, or a host-driven persona payload
- **Whether prompt-cache markers are inserted** — only \`composable\` with \`use_content_blocks=True\` emits the content-block shape that Stage 5 can mark
- **Where the prompt actually lives** — \`stage.config.prompt\` (static), the builder's block list (composable), or a host \`PersonaProvider\` (dynamic_persona)

Stage 3 also writes \`state.tools\` from its bound \`ToolRegistry\` if one was passed in — but the tool list is wired at Pipeline construction, not via the manifest. Tool selection in the curated UI happens in **Stage 10**.`,
  options: [
    {
      id: 'static',
      label: 'Static',
      description: `Returns a single fixed string every turn. The string lives in \`stage.config.prompt\` and is round-tripped via \`configure()\` — what you type in the system-prompt textarea is what the LLM sees.

Default prompt when nothing is set: \`"You are a helpful assistant."\`. Stage 3's \`update_config()\` applies edits at restore-time so reloading a manifest restores your typed prompt.`,
      bestFor: [
        'Single-purpose agents — a customer-support bot with one role, a code reviewer with a fixed style guide, etc.',
        'Pipelines where prompt iteration is the user\'s job — they edit the textarea, not the structure',
        'Default for new pipelines — start with `static`, switch to `composable` only when you need conditional blocks',
      ],
      avoidWhen: [
        'You want different sections (persona / rules / memory) toggled per turn — use `composable`',
        'The persona is loaded from a database keyed by session/user — use `dynamic_persona` with a host-attached provider',
      ],
      config: [
        {
          name: 'config.prompt',
          label: 'System prompt',
          type: 'string',
          default: '""',
          description:
            'Stored on `stage.config`, applied to the builder via `configure({"prompt": "..."})` at restore-time. The curated System prompt textarea writes to this field.',
        },
      ],
      gotchas: [
        '`StaticPromptBuilder.build(state)` ignores `state` entirely — it always returns the same string. If you want per-turn variation (date, memory, etc.), use `composable`.',
        'The default builder ctor uses `"You are a helpful assistant."` if no prompt is passed. With an empty prompt set on `stage.config`, the configured-empty-string wins (you get an empty system prompt, not the default).',
      ],
      codeRef:
        'geny-executor / s03_system/artifact/default/builders.py:StaticPromptBuilder',
    },
    {
      id: 'composable',
      label: 'Composable',
      description: `Assembles the prompt from an **ordered list of blocks**. Each block renders to text given \`state\`; empty renders are skipped; the rest are joined by a separator (default \`\\n\\n\`) or wrapped as Anthropic content blocks if \`use_content_blocks=True\`.

Built-in block types:

- \`PersonaBlock\` — fixed persona / role text
- \`RulesBlock\` — numbered list of rules
- \`DateTimeBlock\` — current UTC date/time line
- \`MemoryContextBlock\` — reads \`state.metadata.memory_context\` (set by Stage 2's retriever) and renders as a "# Relevant Knowledge" block. Empty when no memory.
- \`ToolInstructionsBlock\` — boilerplate "you have tools" line; can take a custom instructions string
- \`CustomBlock\` — arbitrary named block with hardcoded content

**The block list is NOT runtime-configurable from the manifest.** The manifest can name \`composable\` as the builder, but the actual blocks have to be passed at construction time (or the host has to subclass and supply them). Without that wiring, picking \`composable\` from the manifest gives you an empty-block builder that always returns \`""\`.`,
      bestFor: [
        'Pipelines that pre-build a `ComposablePromptBuilder` instance with a curated block list and pass it via `Pipeline(...)` — the manifest then just preserves the choice across snapshot/restore',
        'Memory-aware agents — `MemoryContextBlock` injects retrieved knowledge automatically when Stage 2 has memory to share',
        'Pipelines that want prompt-cache markers — only `composable` with `use_content_blocks=True` emits the content-block shape Stage 5 can mark',
      ],
      avoidWhen: [
        'You want a manifest-only setup. Composable\'s block list isn\'t reachable from the manifest — picking it without host-side population gives an empty prompt.',
        'A single fixed string is fine — `static` is simpler and round-trips through the manifest cleanly.',
      ],
      gotchas: [
        '**Picking `composable` in the manifest with no host-side block list = empty prompt** — same silent trap as Stage 2\'s `static` retriever. The builder has no `configure()` method that accepts blocks, and the manifest can\'t encode `PromptBlock` instances.',
        '`MemoryContextBlock` reads `state.metadata.memory_context` which is only populated on Stage 2 iteration 0 (first turn of a session). For iteration > 0 the block renders to "" and is skipped.',
        '`use_content_blocks=True` is the *only* path that produces cache-markable system blocks. With it off, even `aggressive_cache` Stage 5 strategy can\'t mark the system prompt.',
      ],
      codeRef:
        'geny-executor / s03_system/artifact/default/builders.py:ComposablePromptBuilder',
    },
    {
      id: 'dynamic_persona',
      label: 'Dynamic persona',
      description: `Builder backed by a host-attached \`PersonaProvider\`. The provider returns a persona payload (string + optional metadata) keyed by session / user / tenant, and the builder renders that into \`state.system\`.

Phase 7 Sprint S7.1 introduced this for hosts running multi-tenant agents — the same manifest can serve different personas per request without rebuilding the pipeline.

**Manifest can name it; manifest cannot install it.** Picking \`dynamic_persona\` requires \`Pipeline.attach_runtime(system_builder=DynamicPersonaPromptBuilder(provider=...))\` at session-start time. Without the provider, the slot resolves to an empty/no-op builder.`,
      bestFor: [
        'Multi-tenant SaaS — same manifest, different persona per customer / user',
        'Persona-as-a-service backends — A/B testing different personas without manifest changes',
        'Pipelines where the persona changes during a session (e.g., escalation tiers) and needs runtime lookup',
      ],
      avoidWhen: [
        'You don\'t have a `PersonaProvider` to attach. Without one, this is functionally a no-op.',
        'A static prompt is fine. Don\'t reach for `dynamic_persona` to "future-proof" — it adds host-side wiring that has to be maintained.',
      ],
      gotchas: [
        'Same manifest-only-trap as `composable` — naming it without host-side wiring gives empty system prompt.',
        'The provider is called per-turn (or per-session, depending on the provider implementation). If lookup is slow, it adds latency on every turn before the LLM call.',
      ],
      codeRef:
        'geny-executor / s03_system/persona/builder.py:DynamicPersonaPromptBuilder',
    },
  ],
  relatedSections: [
    {
      label: 'System prompt textarea (this stage)',
      body: 'When `static` is the active builder, the textarea below the picker edits `stage.config.prompt`. The text is what `StaticPromptBuilder.build()` returns every turn.',
    },
    {
      label: 'Stage 2 — Context',
      body: '`composable` with `MemoryContextBlock` reads `state.metadata.memory_context` which Stage 2\'s retriever sets on iteration 0. Without a retriever picking up something, the memory block renders empty.',
    },
    {
      label: 'Stage 5 — Cache',
      body: 'Prompt caching only works on Anthropic models AND only when `composable` is in `use_content_blocks=True` mode. `static` builder produces a plain string which can\'t carry cache_control markers.',
    },
    {
      label: 'Stage 10 — Tools',
      body: 'Tool registration happens in Stage 10, not here. Stage 3 only writes `state.tools` if a `ToolRegistry` was passed at construction time — which Geny preset manifests don\'t do.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s03_system/artifact/default/builders.py',
};

const ko: SectionHelpContent = {
  title: '프롬프트 빌더 (Builder)',
  summary:
    '매 턴 **시스템 프롬프트**를 어떻게 구성할지 결정. 출력은 \`state.system\` 으로 — 6단계 (API) 가 결국 LLM 의 \`system\` 파라미터로 보내는 것.',
  whatItDoes: `3단계는 슬롯 하나 (\`builder\`) 와 출력 하나 (\`state.system\`) 를 가집니다. 2단계 (Context) 후, 4단계 (Guard) 전에 동기 실행.

빌더는 \`PipelineState\` 를 받아 평문 문자열 또는 Anthropic 스타일 content block 리스트를 반환. 빌더 선택이 결정하는 것:

- **프롬프트에 무엇이 들어갈지** — 고정 텍스트, 조합된 블록, 또는 호스트 주도 persona 페이로드
- **prompt-cache 마커가 삽입될지** — \`composable\` + \`use_content_blocks=True\` 만 5단계가 마커 달 수 있는 content-block 모양 emit
- **프롬프트가 실제로 어디 사는지** — \`stage.config.prompt\` (static), 빌더의 블록 리스트 (composable), 또는 호스트 \`PersonaProvider\` (dynamic_persona)

3단계는 또 \`ToolRegistry\` 가 전달됐다면 그것에서 \`state.tools\` 를 씁니다 — 하지만 도구 리스트는 매니페스트가 아닌 Pipeline 생성 시점에 wire 됩니다. curated UI 에서 도구 선택은 **10단계** 에서.`,
  options: [
    {
      id: 'static',
      label: 'Static (정적)',
      description: `매 턴 단일 고정 문자열 반환. 문자열은 \`stage.config.prompt\` 에 살고 \`configure()\` 로 round-trip — 시스템 프롬프트 textarea 에 입력하는 것이 LLM 이 보는 것.

아무것도 설정 안 됐을 때 기본 프롬프트: \`"You are a helpful assistant."\`. 3단계의 \`update_config()\` 가 restore 시점에 편집을 적용 — 매니페스트 재로드 시 입력한 프롬프트 복원.`,
      bestFor: [
        '단일 목적 에이전트 — 한 가지 역할의 고객지원 봇, 고정 스타일 가이드의 코드 리뷰어 등',
        '프롬프트 반복이 사용자의 일인 파이프라인 — 사용자가 textarea 를 편집, 구조는 아님',
        '새 파이프라인의 기본값 — `static` 으로 시작, 조건부 블록이 필요할 때만 `composable` 로 전환',
      ],
      avoidWhen: [
        '턴마다 다른 섹션 (persona / rules / memory) 을 토글하고 싶을 때 — `composable` 사용',
        'persona 가 session/user 키로 데이터베이스에서 로드될 때 — host-attached provider 와 함께 `dynamic_persona`',
      ],
      config: [
        {
          name: 'config.prompt',
          label: '시스템 프롬프트',
          type: 'string',
          default: '""',
          description:
            '`stage.config` 에 저장, restore 시점에 `configure({"prompt": "..."})` 로 빌더에 적용. curated 시스템 프롬프트 textarea 가 이 필드에 씀.',
        },
      ],
      gotchas: [
        '`StaticPromptBuilder.build(state)` 는 `state` 를 완전히 무시 — 항상 같은 문자열 반환. 턴별 변동 (날짜, 메모리 등) 을 원하면 `composable` 사용.',
        '기본 빌더 ctor 는 prompt 가 전달되지 않으면 `"You are a helpful assistant."` 사용. `stage.config` 에 빈 prompt 가 설정되면 configured-empty-string 이 이김 (기본값 아닌 빈 system prompt 가 됨).',
      ],
      codeRef:
        'geny-executor / s03_system/artifact/default/builders.py:StaticPromptBuilder',
    },
    {
      id: 'composable',
      label: 'Composable (조합형)',
      description: `**순서가 있는 블록 리스트** 로부터 프롬프트 조립. 각 블록은 \`state\` 가 주어지면 텍스트로 렌더; 빈 렌더는 skip; 나머지는 separator (기본 \`\\n\\n\`) 로 join 되거나 \`use_content_blocks=True\` 면 Anthropic content block 으로 wrap.

빌트인 블록 타입:

- \`PersonaBlock\` — 고정 persona / 역할 텍스트
- \`RulesBlock\` — 번호 매겨진 규칙 리스트
- \`DateTimeBlock\` — 현재 UTC 날짜/시간 줄
- \`MemoryContextBlock\` — \`state.metadata.memory_context\` (2단계 retriever 가 설정) 를 읽어 "# Relevant Knowledge" 블록으로 렌더. 메모리가 없으면 비어있음.
- \`ToolInstructionsBlock\` — boilerplate "도구가 있다" 줄; 커스텀 instructions 문자열 가능
- \`CustomBlock\` — 임의 이름의 블록 + 하드코딩 내용

**블록 리스트는 매니페스트에서 런타임 구성 불가.** 매니페스트는 빌더로 \`composable\` 을 명명할 수 있지만, 실제 블록은 생성 시점에 전달되어야 함 (호스트가 서브클래스화하고 공급). 그 wiring 없이 매니페스트에서 \`composable\` 을 선택하면 항상 \`""\` 를 반환하는 빈-블록 빌더가 됩니다.`,
      bestFor: [
        '큐레이션된 블록 리스트로 `ComposablePromptBuilder` 인스턴스를 미리 만들어 `Pipeline(...)` 으로 전달하는 파이프라인 — 매니페스트는 snapshot/restore 간 선택을 보존만',
        '메모리 인식 에이전트 — 2단계가 공유할 메모리가 있을 때 `MemoryContextBlock` 이 자동으로 검색된 지식을 주입',
        'prompt-cache 마커를 원하는 파이프라인 — `composable` + `use_content_blocks=True` 만 5단계가 마커 달 수 있는 content-block 모양 emit',
      ],
      avoidWhen: [
        '매니페스트 전용 설정을 원할 때. composable 의 블록 리스트는 매니페스트에서 도달 불가 — 호스트 측 채움 없이 선택하면 빈 프롬프트.',
        '단일 고정 문자열로 충분할 때 — `static` 이 더 단순하고 매니페스트로 깔끔하게 round-trip.',
      ],
      gotchas: [
        '**호스트 측 블록 리스트 없이 매니페스트에서 `composable` 을 선택 = 빈 프롬프트** — 2단계의 `static` retriever 와 동일한 silent trap. 빌더에 블록을 받는 `configure()` 메서드 없고, 매니페스트는 `PromptBlock` 인스턴스를 인코딩 못 함.',
        '`MemoryContextBlock` 은 `state.metadata.memory_context` 를 읽는데, 이는 2단계 iteration 0 (세션의 첫 턴) 에만 채워짐. iteration > 0 에서 블록은 "" 로 렌더되고 skip.',
        '`use_content_blocks=True` 는 cache 마커 가능한 system 블록을 만드는 *유일한* 경로. 그것 없이는 `aggressive_cache` 5단계 전략도 system prompt 에 마커 못 함.',
      ],
      codeRef:
        'geny-executor / s03_system/artifact/default/builders.py:ComposablePromptBuilder',
    },
    {
      id: 'dynamic_persona',
      label: 'Dynamic persona (동적 페르소나)',
      description: `호스트가 attach 한 \`PersonaProvider\` 가 backing 하는 빌더. 프로바이더가 session / user / tenant 키로 persona 페이로드 (문자열 + 선택적 메타데이터) 를 반환하고, 빌더가 그것을 \`state.system\` 으로 렌더.

Phase 7 Sprint S7.1 가 multi-tenant 에이전트 운영 호스트를 위해 도입 — 같은 매니페스트로 요청별 다른 persona 를 파이프라인 재구성 없이 제공.

**매니페스트가 명명 가능; 매니페스트가 설치 불가.** \`dynamic_persona\` 선택은 세션 시작 시점에 \`Pipeline.attach_runtime(system_builder=DynamicPersonaPromptBuilder(provider=...))\` 가 필요. provider 없이 슬롯은 빈/no-op 빌더로 resolve.`,
      bestFor: [
        '멀티 테넌트 SaaS — 같은 매니페스트, 고객/사용자별 다른 persona',
        'Persona-as-a-service 백엔드 — 매니페스트 변경 없이 다른 persona A/B 테스트',
        '세션 중 persona 가 변하는 (예: 에스컬레이션 단계) 런타임 lookup 이 필요한 파이프라인',
      ],
      avoidWhen: [
        'attach 할 `PersonaProvider` 가 없을 때. provider 없이 이는 기능적으로 no-op.',
        '정적 프롬프트로 충분할 때. 유지보수가 필요한 호스트 측 wiring 을 추가하므로 "future-proof" 하려고 `dynamic_persona` 를 잡지 마세요.',
      ],
      gotchas: [
        '`composable` 과 동일한 manifest-only-trap — 호스트 측 wiring 없이 명명하면 빈 system prompt.',
        'provider 는 턴별로 호출됨 (provider 구현에 따라 세션별일 수도). lookup 이 느리면 LLM 호출 전 매 턴 latency 추가.',
      ],
      codeRef:
        'geny-executor / s03_system/persona/builder.py:DynamicPersonaPromptBuilder',
    },
  ],
  relatedSections: [
    {
      label: '시스템 프롬프트 textarea (이 단계)',
      body: '`static` 이 활성 빌더일 때 picker 아래의 textarea 가 `stage.config.prompt` 를 편집. 텍스트가 매 턴 `StaticPromptBuilder.build()` 가 반환하는 것.',
    },
    {
      label: '2단계 — Context',
      body: '`MemoryContextBlock` 이 있는 `composable` 은 2단계의 retriever 가 iteration 0 에 설정한 `state.metadata.memory_context` 를 읽음. retriever 가 무언가를 가져오지 않으면 메모리 블록은 비어 렌더.',
    },
    {
      label: '5단계 — Cache',
      body: 'Prompt 캐싱은 Anthropic 모델에서만 작동하고 `composable` 이 `use_content_blocks=True` 모드일 때만. `static` 빌더는 cache_control 마커를 운반 못 하는 평문 문자열 생성.',
    },
    {
      label: '10단계 — Tools',
      body: '도구 등록은 여기가 아닌 10단계에서. 3단계는 생성 시점에 `ToolRegistry` 가 전달된 경우만 `state.tools` 를 쓰는데 — Geny preset 매니페스트는 그렇게 하지 않음.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s03_system/artifact/default/builders.py',
};

export const stage03BuilderHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
