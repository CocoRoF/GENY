/**
 * Help content for Stage 18 → Memory strategy slot.
 */

import type { SectionHelpContent, SectionHelpFactory } from '../types';

const en: SectionHelpContent = {
  title: 'Memory strategy',
  summary:
    "How the agent captures memory between turns. Stage 18 is the **write** path; Stage 2's retriever is the **read** path. Strategy choice trades simplicity (append-only) against fidelity (LLM-driven reflective summaries).",
  whatItDoes: `Stage 18 fires after every turn (post-loop tail) and produces what gets remembered for future sessions:

- **append_only** — save every message verbatim; simple, predictable, can grow large
- **no_memory** — discard everything; stateless agent
- **reflective** — LLM extracts insights ("user prefers concise answers", "they're working on X project") and stores those instead of raw transcripts
- **structured_reflective** — reflective + typed insights (entities, projects, decisions) for programmatic retrieval

The choice depends on **what you want Stage 2's retriever to surface in future sessions**:

- Raw transcript matches? → \`append_only\` + a transcript-search retriever
- Distilled facts about the user? → \`reflective\` + a relevance-ranking retriever
- Typed knowledge graph (companies, dates, decisions)? → \`structured_reflective\`

**Reflective costs an extra LLM call per turn.** That's the price of insight extraction. \`structured_reflective\` adds typing on top — slightly more expensive prompts, more queryable output.`,
  options: [
    {
      id: 'append_only',
      label: 'Append-only',
      description: `Save every message verbatim into the memory store. No transformation, no summarisation, no extraction. The simplest, most predictable strategy — easy to debug and audit.

Memory grows linearly with conversation length. Long sessions produce large memory blobs that retrieval has to wade through.`,
      bestFor: [
        'Debug / audit pipelines — every word the user / agent said is captured',
        'Short-session agents where memory size won\'t balloon',
        'Pipelines with full-text search retrievers that thrive on raw transcript',
      ],
      avoidWhen: [
        'Long-session agents — memory grows unbounded; retrieval slows down',
        'You actually want distilled insights, not raw history — use `reflective`',
      ],
      gotchas: [
        'Privacy implication: every word is stored. If users mention sensitive info, that goes to the memory provider verbatim. Pair with a Stage 8 thinking filter or a custom redaction pass if needed.',
      ],
      codeRef:
        'geny-executor / s18_memory/artifact/default/strategies.py:AppendOnlyStrategy',
    },
    {
      id: 'no_memory',
      label: 'No memory',
      description: `Discard everything between turns. Stage 18 is effectively a no-op for the memory provider — nothing gets written.

Stateless agents. Each turn is independent. Pair with Stage 2 \`stateless: true\` for a truly memoryless pipeline.`,
      bestFor: [
        'API endpoints / one-shot tools',
        'Test pipelines where memory would introduce non-determinism',
        'Privacy-critical contexts where storing anything is forbidden',
      ],
      avoidWhen: [
        'Conversational agents — users expect "you remember what I said earlier"',
      ],
      gotchas: [
        '`no_memory` here doesn\'t prevent in-session memory (Stage 2\'s `state.messages` still has history). It only stops *cross-session* memory.',
      ],
      codeRef:
        'geny-executor / s18_memory/artifact/default/strategies.py:NoMemoryStrategy',
    },
    {
      id: 'reflective',
      label: 'Reflective (LLM)',
      description: `An LLM call extracts insights from the turn — what the user wants, what they\'ve revealed, what was decided. The insights are stored instead of raw text.

Costs an extra LLM call per turn. Worth it when:

- conversations are long and raw history would dominate the memory store
- retrieval queries are about *meaning*, not literal substrings
- you want a more useful "what do we know about this user" snapshot than the transcript provides`,
      bestFor: [
        'Long-running personal assistants',
        'Agents that need to reason about user preferences across sessions',
        'Pipelines paired with semantic retrieval (embedding search on insight texts)',
      ],
      avoidWhen: [
        'Cost-sensitive workloads — extra LLM call per turn adds up',
        'Pipelines where the full transcript IS the memory (debug, audit)',
      ],
      gotchas: [
        'The reflective strategy uses Stage 18\'s **memory model** (the model_override section below). If that\'s not configured, it falls back to the pipeline default — which is usually wasteful (you don\'t need GPT-4 for "extract user preferences"; use a cheaper model).',
        'Insight quality depends on the model + prompt. Bad insights make memory less useful than the transcript.',
      ],
      codeRef:
        'geny-executor / s18_memory/artifact/default/strategies.py:ReflectiveStrategy',
    },
    {
      id: 'structured_reflective',
      label: 'Structured reflective',
      description: `Reflective + **typed insights**: entities (people, companies), projects, decisions, preferences. Each insight has a type tag so retrieval can filter by category.

The LLM is prompted to produce structured output (JSON) listing entities + relations. Best paired with knowledge-graph-style retrievers that can answer "tell me about person X" or "what decisions were made on project Y".`,
      bestFor: [
        'Multi-turn workflows where structured recall matters (e.g., "the spec from session 3")',
        'Long-lived agents serving the same user across many sessions',
        'Pipelines with typed retrievers that benefit from category filtering',
      ],
      avoidWhen: [
        'Quick / casual chat — the structure overhead doesn\'t pay off',
        'Pipelines without a structured retriever to consume the typing',
      ],
      gotchas: [
        'Insight extraction is JSON-shaped. Models occasionally produce malformed JSON; the strategy logs and skips those turns rather than crashing — but you lose memory for that turn.',
        'Same memory-model dependency as `reflective` — set the model override below to a cheap model.',
      ],
      codeRef:
        'geny-executor / s18_memory/artifact/default/strategies.py:StructuredReflectiveStrategy',
    },
  ],
  relatedSections: [
    {
      label: 'Persistence (next section in this stage)',
      body: 'Strategy decides WHAT to remember; persistence decides WHERE it lives (in-memory, file, etc.). Both required.',
    },
    {
      label: 'Memory model (next-next section)',
      body: 'Reflective and structured_reflective use a model_override on this stage. Without it, they call the pipeline default — usually wasteful.',
    },
    {
      label: 'Stage 2 — Retriever',
      body: 'Stage 2 reads what Stage 18 wrote. Pair them sensibly: append_only + transcript search, reflective + semantic search, structured_reflective + typed retriever.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s18_memory/artifact/default/strategies.py',
};

const ko: SectionHelpContent = {
  title: '메모리 전략 (Memory strategy)',
  summary:
    '에이전트가 턴 사이 메모리를 어떻게 캡처할지. 18단계는 **쓰기** 경로; 2단계의 retriever 가 **읽기** 경로. 전략 선택이 단순성 (append-only) 대 fidelity (LLM 주도 reflective 요약) 를 trade.',
  whatItDoes: `18단계는 매 턴 후 (post-loop tail) 발화하고 미래 세션을 위해 무엇이 기억될지 생산:

- **append_only** — 모든 메시지 verbatim 저장; 단순, 예측 가능, 커질 수 있음
- **no_memory** — 모든 것 폐기; 상태 없는 에이전트
- **reflective** — LLM 이 인사이트 ("사용자가 간결한 답변 선호", "X 프로젝트 작업 중") 추출하고 raw 트랜스크립트 대신 그것 저장
- **structured_reflective** — reflective + 타입드 인사이트 (entities, projects, decisions) — 프로그래밍 방식 검색용

선택은 **2단계의 retriever 가 미래 세션에서 무엇을 surface 하길 원하는지**에 달림:

- Raw 트랜스크립트 매칭? → \`append_only\` + 트랜스크립트 검색 retriever
- 사용자에 대한 distilled 사실? → \`reflective\` + relevance-ranking retriever
- 타입드 지식 그래프 (회사, 날짜, 결정)? → \`structured_reflective\`

**Reflective 는 턴당 추가 LLM 호출 비용.** 그것이 인사이트 추출의 가격. \`structured_reflective\` 가 그 위에 typing 추가 — 약간 더 비싼 프롬프트, 더 쿼리 가능한 출력.`,
  options: [
    {
      id: 'append_only',
      label: 'Append-only (추가만)',
      description: `모든 메시지를 verbatim 으로 메모리 저장소에 저장. 변환 없음, 요약 없음, 추출 없음. 가장 단순하고 예측 가능한 전략 — 디버그와 감사가 쉬움.

메모리가 대화 길이에 선형적으로 자람. 장기 세션이 retrieval 이 헤쳐 나가야 하는 큰 메모리 blob 생산.`,
      bestFor: [
        '디버그 / 감사 파이프라인 — 사용자 / 에이전트가 말한 모든 단어 캡처',
        '메모리 크기가 부풀지 않는 짧은 세션 에이전트',
        'Raw 트랜스크립트에서 잘 작동하는 full-text 검색 retriever 의 파이프라인',
      ],
      avoidWhen: [
        '장기 세션 에이전트 — 메모리 무제한 자람; retrieval 느려짐',
        'Raw 히스토리가 아닌 distilled 인사이트 원할 때 — `reflective` 사용',
      ],
      gotchas: [
        '프라이버시 함의: 모든 단어가 저장됨. 사용자가 민감 정보 언급하면 그것이 메모리 provider 로 verbatim. 필요하면 8단계 thinking 필터나 커스텀 redaction pass 와 짝.',
      ],
      codeRef:
        'geny-executor / s18_memory/artifact/default/strategies.py:AppendOnlyStrategy',
    },
    {
      id: 'no_memory',
      label: '메모리 없음 (No memory)',
      description: `턴 사이 모든 것 폐기. 18단계가 메모리 provider 에 사실상 no-op — 아무것도 쓰여지지 않음.

상태 없는 에이전트. 각 턴이 독립. 진짜 메모리 없는 파이프라인은 2단계 \`stateless: true\` 와 짝.`,
      bestFor: [
        'API 엔드포인트 / 일회성 도구',
        '메모리가 비결정성을 도입할 테스트 파이프라인',
        '무엇이든 저장이 금지된 프라이버시 critical 컨텍스트',
      ],
      avoidWhen: [
        '대화 에이전트 — 사용자가 "전에 말한 거 기억해" 기대',
      ],
      gotchas: [
        '여기 `no_memory` 가 세션 내 메모리 막지 않음 (2단계의 `state.messages` 가 여전히 히스토리 있음). 단지 *세션 간* 메모리만 멈춤.',
      ],
      codeRef:
        'geny-executor / s18_memory/artifact/default/strategies.py:NoMemoryStrategy',
    },
    {
      id: 'reflective',
      label: '리플렉티브 (Reflective — LLM)',
      description: `LLM 호출이 턴에서 인사이트 추출 — 사용자가 원하는 것, 드러낸 것, 결정된 것. 인사이트가 raw 텍스트 대신 저장.

턴당 추가 LLM 호출 비용. 가치 있을 때:

- 대화가 길고 raw 히스토리가 메모리 저장소 dominate
- Retrieval 쿼리가 *의미*에 관한 것, 리터럴 substring 아님
- 트랜스크립트가 제공하는 것보다 더 유용한 "이 사용자에 대해 무엇을 알지" 스냅샷 원함`,
      bestFor: [
        '장기 운영 개인 비서',
        '세션 간 사용자 선호도에 대해 reasoning 해야 하는 에이전트',
        '시맨틱 retrieval (인사이트 텍스트의 임베딩 검색) 과 짝지어진 파이프라인',
      ],
      avoidWhen: [
        '비용 민감 워크로드 — 턴당 추가 LLM 호출 누적',
        '전체 트랜스크립트가 메모리인 파이프라인 (디버그, 감사)',
      ],
      gotchas: [
        'Reflective 전략은 18단계의 **메모리 모델** (아래 model_override 섹션) 사용. 구성 안 되면 파이프라인 기본값으로 fallback — 보통 낭비 ("사용자 선호 추출" 에 GPT-4 필요 없음; 더 싼 모델 사용).',
        '인사이트 품질이 모델 + 프롬프트에 달림. 나쁜 인사이트는 메모리를 트랜스크립트보다 덜 유용하게 만듦.',
      ],
      codeRef:
        'geny-executor / s18_memory/artifact/default/strategies.py:ReflectiveStrategy',
    },
    {
      id: 'structured_reflective',
      label: '구조화 리플렉티브 (Structured reflective)',
      description: `Reflective + **타입드 인사이트**: entities (사람, 회사), projects, decisions, preferences. 각 인사이트가 type 태그 가져 retrieval 이 카테고리로 필터 가능.

LLM 이 entities + relations 나열하는 구조화 출력 (JSON) 생산하도록 prompt. 지식 그래프 스타일 retriever 와 가장 잘 짝 — "X 사람에 대해 알려줘" 또는 "Y 프로젝트에 어떤 결정이 내려졌나" 같은 답변.`,
      bestFor: [
        '구조화 recall 이 중요한 멀티턴 워크플로 (예: "세션 3 의 spec")',
        '많은 세션에 걸쳐 같은 사용자를 서비스하는 장기 에이전트',
        '카테고리 필터링에서 이익 보는 타입드 retriever 의 파이프라인',
      ],
      avoidWhen: [
        '빠른 / 캐주얼 채팅 — 구조 오버헤드가 가치 없음',
        'Typing 을 소비할 구조화 retriever 없는 파이프라인',
      ],
      gotchas: [
        '인사이트 추출이 JSON 모양. 모델이 가끔 잘못된 JSON 생산; 전략이 그 턴들을 로그하고 skip — 크래시 아니지만 그 턴의 메모리 잃음.',
        '`reflective` 와 동일한 메모리 모델 의존성 — 아래 모델 override 를 싼 모델로 설정.',
      ],
      codeRef:
        'geny-executor / s18_memory/artifact/default/strategies.py:StructuredReflectiveStrategy',
    },
  ],
  relatedSections: [
    {
      label: '영속성 (이 단계의 다음 섹션)',
      body: 'Strategy 가 무엇을 기억할지 결정; persistence 가 어디 사는지 결정 (in-memory, file 등). 둘 다 필요.',
    },
    {
      label: '메모리 모델 (다음다음 섹션)',
      body: 'Reflective 와 structured_reflective 가 이 단계의 model_override 사용. 그것 없이 파이프라인 기본 호출 — 보통 낭비.',
    },
    {
      label: '2단계 — Retriever',
      body: '2단계가 18단계가 쓴 것 읽음. 합리적으로 짝: append_only + 트랜스크립트 검색, reflective + 시맨틱 검색, structured_reflective + 타입드 retriever.',
    },
  ],
  codeRef:
    'geny-executor / src/geny_executor/stages/s18_memory/artifact/default/strategies.py',
};

export const stage18StrategyHelp: SectionHelpFactory = (locale) =>
  locale === 'ko' ? ko : en;
