/** Tool detail — memory_write (Geny / memory family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `memory_write creates a new memory note in the agent's session memory store. Memory notes are short, semantically-tagged knowledge fragments — facts, decisions, insights, references — that the agent recalls later via memory_search or memory_list.

Each note has:
  - \`body\`: the actual content (the agent's words)
  - \`category\`: one of a curated taxonomy (\`topic\`, \`decision\`, \`insight\`, \`person\`, \`reference\`, etc.) — drives later filtering
  - \`tags\`: optional free-form tags for cross-cutting organisation
  - \`importance\`: 1-5 scale; the memory provider weights search ranking by importance + recency

Memory is the agent's working knowledge layer — distinct from:
  - Conversation history (raw turns)
  - Curated knowledge (sweetened by the user, lives in knowledge_*)
  - System prompt (static identity / rules)

Notes persist across turns and (depending on the memory backend) across sessions. The default backend is per-session; configure a persistent backend to retain memory across reboots.

The semantic search index updates incrementally — newly-written notes are searchable on the next turn. The agent should write notes whenever it learns something it might want to recall later, even if the immediate task doesn't need it.`,
  bestFor: [
    'Recording decisions ("agreed to use Sonnet 4.6 for the reviewer role")',
    'Capturing user preferences and idioms (\"user prefers terse PR descriptions\")',
    'Storing facts uncovered during research (\"library X requires API key in header, not body\")',
    'Building up a working memory across long sessions',
  ],
  avoidWhen: [
    'The information is curated knowledge — use knowledge_promote to send it to the curated layer',
    'The data is huge / structured — write to a file via Write and reference the path',
    'The agent already has it in conversation context and the session is short',
  ],
  gotchas: [
    'No idempotency check — repeated writes of the same content create duplicates. Use memory_search first if you\'re unsure.',
    'Importance is advisory; the memory provider may rank by recency or other signals depending on backend.',
    'Tag explosion: agents that tag everything generously make filtering useless. Pick consistent tags or skip them.',
    'Notes don\'t expire automatically. Long-running deployments accumulate; periodic memory_delete cleanup helps.',
  ],
  examples: [
    {
      caption: 'Capture a decision with category and importance',
      body: `{
  "body": "Agreed: vector store for memory. Pinecone, free tier OK for MVP.",
  "category": "decision",
  "tags": ["infra", "memory"],
  "importance": 4
}`,
      note: 'Returns the new note\'s ID. Searchable on the next turn.',
    },
  ],
  relatedTools: [
    'memory_read',
    'memory_search',
    'memory_list',
    'memory_update',
    'memory_delete',
    'knowledge_promote',
  ],
  relatedStages: ['Stage 18 (Memory)'],
  codeRef:
    'Geny / backend/tools/built_in/memory_tools.py:MemoryWriteTool',
};

const ko: ToolDetailContent = {
  body: `memory_write는 에이전트 세션 메모리 스토어에 새 메모리 노트를 생성합니다. 메모리 노트는 짧고 시맨틱 태그된 지식 조각 — 사실, 결정, 통찰, 참조 — 에이전트가 나중에 memory_search 또는 memory_list로 회상.

각 노트:
  - \`body\`: 실제 콘텐츠(에이전트의 단어)
  - \`category\`: 큐레이션된 분류 중 하나(\`topic\`, \`decision\`, \`insight\`, \`person\`, \`reference\` 등) — 나중 필터링 주도
  - \`tags\`: 교차적 조직화를 위한 선택적 자유 형식 태그
  - \`importance\`: 1-5 스케일; 메모리 프로바이더가 importance + recency로 검색 ranking weight

메모리는 에이전트의 working 지식 레이어 — 다음과 구별:
  - 대화 history(raw 턴)
  - 큐레이션된 지식(사용자가 검증, knowledge_*에 위치)
  - 시스템 프롬프트(정적 정체성 / 규칙)

노트는 턴 가로질러 영속하고 (메모리 백엔드에 따라) 세션 가로질러 영속. 기본 백엔드는 세션별; 재부팅 가로질러 메모리 보유하려면 영속 백엔드 설정.

시맨틱 검색 인덱스는 점진적으로 업데이트 — 새로 작성된 노트는 다음 턴에 검색 가능. 즉각 task에 필요 없어도 나중에 회상하고 싶을 만한 것을 학습했을 때마다 에이전트가 노트 작성해야 함.`,
  bestFor: [
    '결정 기록("reviewer 역할에 Sonnet 4.6 사용 동의")',
    '사용자 선호와 관용어 캡처("사용자가 간결한 PR 설명 선호")',
    '리서치 중 발견된 사실 저장("라이브러리 X는 API 키를 body 아닌 header에 요구")',
    '긴 세션 가로질러 working 메모리 구축',
  ],
  avoidWhen: [
    '정보가 큐레이션된 지식 — knowledge_promote로 큐레이션 레이어로 보내기',
    '데이터가 크거나 구조화 — Write로 파일에 쓰고 경로 참조',
    '에이전트가 이미 대화 컨텍스트에 가지고 있고 세션이 짧음',
  ],
  gotchas: [
    'Idempotency 체크 없음 — 같은 콘텐츠 반복 쓰기는 중복 생성. 불확실하면 먼저 memory_search.',
    'Importance는 advisory; 메모리 프로바이더가 백엔드에 따라 recency나 다른 신호로 ranking할 수 있음.',
    '태그 폭발: 모든 것에 관대하게 태그 다는 에이전트는 필터링 무용. 일관된 태그 선택 또는 skip.',
    '노트는 자동 만료 안 함. 장기 배포는 누적; 주기적 memory_delete cleanup이 도움.',
  ],
  examples: [
    {
      caption: 'category와 importance와 함께 결정 캡처',
      body: `{
  "body": "동의: 메모리는 vector store. Pinecone, MVP는 free tier OK.",
  "category": "decision",
  "tags": ["infra", "memory"],
  "importance": 4
}`,
      note: '새 노트의 ID 반환. 다음 턴에 검색 가능.',
    },
  ],
  relatedTools: [
    'memory_read',
    'memory_search',
    'memory_list',
    'memory_update',
    'memory_delete',
    'knowledge_promote',
  ],
  relatedStages: ['18단계 (Memory)'],
  codeRef:
    'Geny / backend/tools/built_in/memory_tools.py:MemoryWriteTool',
};

export const memoryWriteToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
