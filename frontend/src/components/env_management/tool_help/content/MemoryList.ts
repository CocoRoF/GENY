/** Tool detail — memory_list (Geny / memory family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `memory_list enumerates memory notes by metadata filters — category, tags, importance threshold, recency window. Unlike memory_search (which ranks by relevance to a query), memory_list returns inventory: "show me all decision notes from this week", "list everything tagged frontend".

Use cases:
  - Audit ("what does the agent remember about user preferences?")
  - Cleanup ("anything older than 6 months and importance ≤ 2 → memory_delete")
  - Browse ("walk me through all decisions made this session")

Result is paginated. Default \`limit: 50\`; sort by recency by default, with \`sort_by: "importance"\` available. Each entry is metadata only (no body) — the agent picks one and memory_read for full content.

This is the bulk-inspection counterpart to memory_search. Search optimises for relevance; List optimises for completeness within a slice.`,
  bestFor: [
    'Inventory by category ("all decisions") or tag',
    'Cleanup before memory_delete',
    'Pre-flight before writing — "does the agent already have notes on this topic?"',
  ],
  avoidWhen: [
    'You\'re looking for relevance — memory_search ranks by query',
    'You want one specific note — memory_read by ID',
  ],
  gotchas: [
    'No body in the response — saves tokens, but the agent must memory_read to see actual content.',
    'Default sort is recency. For "most important first", pass `sort_by: "importance"`.',
    'Pagination on large stores — only the first page returned by default. Pass `offset` and `limit` for the rest.',
    'Filter combinations are AND. Empty result with strict filters often means the filters are too narrow, not that no notes exist.',
  ],
  examples: [
    {
      caption: 'List recent high-importance decisions',
      body: `{
  "category": "decision",
  "min_importance": 4,
  "limit": 20
}`,
      note: 'Returns up to 20 metadata entries sorted recency-first. Agent picks IDs to memory_read.',
    },
  ],
  relatedTools: ['memory_read', 'memory_search', 'memory_delete'],
  relatedStages: ['Stage 18 (Memory)'],
  codeRef:
    'Geny / backend/tools/built_in/memory_tools.py:MemoryListTool',
};

const ko: ToolDetailContent = {
  body: `memory_list는 메타데이터 필터로 메모리 노트를 enumerate — category, tags, importance 임계값, recency window. 쿼리에 대한 관련도로 ranking하는 memory_search와 달리 memory_list는 inventory 반환: "이번 주의 모든 decision 노트 보여줘", "frontend 태그된 모든 것 list".

사용 사례:
  - Audit("에이전트가 사용자 선호에 대해 무엇을 기억하나?")
  - Cleanup("6개월 넘고 importance ≤ 2인 것 → memory_delete")
  - Browse("이 세션에서 만든 모든 결정 walk through")

결과는 페이지네이션. 기본 \`limit: 50\`; 기본 recency 정렬, \`sort_by: "importance"\` 가능. 각 항목은 메타데이터만(body 없음) — 에이전트가 하나 골라 풀 콘텐츠는 memory_read.

memory_search의 벌크 검사 카운터파트. 검색은 관련도 최적화; List는 슬라이스 내 완전성 최적화.`,
  bestFor: [
    'Category("모든 decisions") 또는 태그별 inventory',
    'memory_delete 전 cleanup',
    '쓰기 전 사전 확인 — "에이전트가 이 주제에 노트 이미 있나?"',
  ],
  avoidWhen: [
    '관련도 찾는 경우 — memory_search가 쿼리로 ranking',
    '특정 노트 하나 — ID로 memory_read',
  ],
  gotchas: [
    '응답에 body 없음 — 토큰 절약, 하지만 에이전트가 실제 콘텐츠 보려면 memory_read 필요.',
    '기본 정렬은 recency. "가장 중요한 것 먼저"는 `sort_by: "importance"` 전달.',
    '큰 store의 페이지네이션 — 기본은 첫 페이지만. 나머지는 `offset`과 `limit` 전달.',
    '필터 조합 AND. 엄격한 필터의 빈 결과는 노트 없음 아니라 필터가 너무 좁다는 의미일 때가 많음.',
  ],
  examples: [
    {
      caption: '최근 고importance 결정 list',
      body: `{
  "category": "decision",
  "min_importance": 4,
  "limit": 20
}`,
      note: 'recency 우선 정렬된 메타데이터 항목 최대 20개 반환. 에이전트가 memory_read할 ID 선택.',
    },
  ],
  relatedTools: ['memory_read', 'memory_search', 'memory_delete'],
  relatedStages: ['18단계 (Memory)'],
  codeRef:
    'Geny / backend/tools/built_in/memory_tools.py:MemoryListTool',
};

export const memoryListToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
