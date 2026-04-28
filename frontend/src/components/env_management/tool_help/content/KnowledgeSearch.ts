/** Tool detail — knowledge_search (Geny / knowledge family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `knowledge_search retrieves notes from the user's curated knowledge base — quality-verified, refined records that have been promoted from raw memory or originally authored by the user. Where memory_search hits the agent's working memory (transient, agent-written), knowledge_search hits curated knowledge (persistent, human-vetted).

Two-tier model:
  - Memory: agent's scratchpad. Search via memory_search.
  - Knowledge: user's vault. Search via knowledge_search.

The promotion path is one-way: memory_promote sweetens a memory note into knowledge. Demotion isn't a built-in primitive (use knowledge_delete + memory_write if needed).

Knowledge ranks higher in agent reasoning when there's overlap — the agent should prefer knowledge over memory when both surface relevant content. The user has approved knowledge entries; memory entries reflect the agent\'s opinion.

Filters mirror memory_search: \`category\`, \`tags\`, \`limit\`. Returns the most relevant matches with snippets and IDs.`,
  bestFor: [
    'Recalling user-approved facts before making a decision',
    'Citing knowledge in responses ("according to your notes…")',
    'Cross-referencing curated material when memory is uncertain',
  ],
  avoidWhen: [
    'You\'re looking for the agent\'s working scratch — memory_search instead',
    'You don\'t have a query — knowledge_list to browse',
    'The user hasn\'t curated any knowledge yet — empty results, no fallback',
  ],
  gotchas: [
    'Knowledge and memory are SEPARATE stores. A search in one doesn\'t see the other.',
    'Newly-promoted notes may take a moment to appear in knowledge_search results (re-indexing).',
    'User-edited knowledge can drift from how the agent originally wrote it. Trust the latest knowledge over older memory.',
    'Empty result is meaningful — "the user has no curated knowledge on X" vs "I haven\'t written about X yet".',
  ],
  examples: [
    {
      caption: 'Look up curated knowledge about a deployment',
      body: `{
  "query": "production deployment runbook",
  "category": "reference",
  "limit": 5
}`,
      note: 'Returns top 5 curated reference notes ranked by relevance.',
    },
  ],
  relatedTools: [
    'knowledge_read',
    'knowledge_list',
    'knowledge_promote',
    'memory_search',
  ],
  relatedStages: ['Stage 18 (Memory)'],
  codeRef:
    'Geny / backend/tools/built_in/knowledge_tools.py:KnowledgeSearchTool',
};

const ko: ToolDetailContent = {
  body: `knowledge_search는 사용자의 큐레이션된 지식 베이스에서 노트 검색 — raw 메모리에서 승격되거나 사용자가 처음부터 작성한 품질 검증되고 정제된 레코드. memory_search가 에이전트의 working 메모리(transient, 에이전트 작성)를 hit하는 반면 knowledge_search는 큐레이션된 지식(영속, 사람 검증)을 hit.

두 티어 모델:
  - Memory: 에이전트의 스크래치패드. memory_search로 검색.
  - Knowledge: 사용자의 vault. knowledge_search로 검색.

승격 경로는 단방향: memory_promote가 메모리 노트를 지식으로 sweeten. 강등은 빌트인 primitive 아님(필요 시 knowledge_delete + memory_write).

Knowledge는 겹침 있을 때 에이전트 추론에서 더 높은 weight — 둘 다 관련 콘텐츠 표면화하면 에이전트가 memory보다 knowledge 선호. 사용자가 knowledge 항목 승인; 메모리 항목은 에이전트 의견 반영.

필터는 memory_search 미러: \`category\`, \`tags\`, \`limit\`. snippet과 ID와 함께 가장 관련 있는 매칭 반환.`,
  bestFor: [
    '결정 전 사용자 승인 사실 회상',
    '응답에서 지식 인용("당신의 노트에 따르면…")',
    '메모리가 불확실할 때 큐레이션된 자료 cross-reference',
  ],
  avoidWhen: [
    '에이전트의 working 스크래치 찾기 — memory_search',
    '쿼리 없음 — 브라우징은 knowledge_list',
    '사용자가 아직 지식 큐레이션 안 함 — 빈 결과, fallback 없음',
  ],
  gotchas: [
    'Knowledge와 memory는 별개 store. 한 곳 검색이 다른 곳 안 봄.',
    '새로 승격된 노트가 knowledge_search 결과에 나타나려면 잠시 걸릴 수 있음(재인덱싱).',
    '사용자 편집된 지식은 에이전트가 처음 작성한 것과 drift 가능. 옛 메모리보다 최신 지식 신뢰.',
    '빈 결과 의미 있음 — "사용자가 X에 대한 큐레이션 지식 없음" vs "아직 X에 대해 안 썼음".',
  ],
  examples: [
    {
      caption: '배포 관련 큐레이션 지식 lookup',
      body: `{
  "query": "production deployment runbook",
  "category": "reference",
  "limit": 5
}`,
      note: '관련도로 ranking된 큐레이션 reference 노트 top 5 반환.',
    },
  ],
  relatedTools: [
    'knowledge_read',
    'knowledge_list',
    'knowledge_promote',
    'memory_search',
  ],
  relatedStages: ['18단계 (Memory)'],
  codeRef:
    'Geny / backend/tools/built_in/knowledge_tools.py:KnowledgeSearchTool',
};

export const knowledgeSearchToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
