/** Tool detail — memory_search (Geny / memory family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `memory_search retrieves relevant memory notes by combining text matching and semantic vector similarity. The memory provider runs both passes (BM25 / lexical for exact terms + dense vectors for semantic similarity), merges the rankings, and returns the top-k.

This is the agent's primary recall path — when something feels familiar but isn\'t in immediate context, the agent searches memory before assuming it\'s new. Effective searches use intent words rather than literal phrasing: a note about "user prefers terse PR descriptions" surfaces well for a query like "user PR style preferences" even without exact word overlap.

Filters narrow the result set:
  - \`category\`: scope to one type (\`decision\` / \`insight\` / etc.)
  - \`tags\`: AND across tags
  - \`min_importance\`: drop low-importance notes for high-stakes recall
  - \`limit\`: top-k cap (default ~10)

Result shape: \`{id, snippet, category, tags, score}\`. Snippets are 1-3 sentence excerpts highlighting the matching part — enough to decide whether to memory_read the full note.

Search uses the latest indexed state — a note written in the previous turn IS searchable. There\'s no commit-then-rebuild step.`,
  bestFor: [
    'Recalling whether the user mentioned X earlier in (or before) the session',
    'Finding similar previous decisions before making a new one',
    'Spotting contradictions ("did the agent already decide this differently?")',
    'Surfacing context the agent might otherwise miss',
  ],
  avoidWhen: [
    'You already know the note ID — memory_read directly',
    'You want a full inventory — memory_list',
    'You\'re searching curated knowledge — knowledge_search is the right surface',
  ],
  gotchas: [
    'Hybrid scoring means low-text-match but high-semantic-match notes can rank above exact term hits. Useful but occasionally surprising.',
    'Empty result is a real signal — "no match" usually means "the agent has never written about this".',
    'Limit defaults to ~10. For brainstorm-style queries you may want more; for pinpoint lookups, less is cleaner.',
    'Filter combinations are AND. Restrictive filters can return empty even when good matches exist with weaker filters.',
  ],
  examples: [
    {
      caption: 'Recall decisions about deployment infra',
      body: `{
  "query": "deployment infrastructure choices",
  "category": "decision",
  "min_importance": 3,
  "limit": 5
}`,
      note: 'Returns up to 5 high-importance decision notes scored by relevance to the query.',
    },
  ],
  relatedTools: ['memory_read', 'memory_write', 'memory_list', 'knowledge_search'],
  relatedStages: ['Stage 18 (Memory)'],
  codeRef:
    'Geny / backend/tools/built_in/memory_tools.py:MemorySearchTool',
};

const ko: ToolDetailContent = {
  body: `memory_search는 텍스트 매칭과 시맨틱 벡터 유사도를 결합해 관련 메모리 노트를 검색합니다. 메모리 프로바이더가 두 패스 실행(정확한 용어용 BM25 / lexical + 시맨틱 유사도용 dense vectors), ranking 병합, top-k 반환.

에이전트의 주 회상 경로 — 익숙해 보이지만 즉각 컨텍스트에 없을 때 에이전트가 새 거라고 가정하기 전 메모리 검색. 효과적인 검색은 문자 그대로의 표현보다 의도 단어 사용: "사용자가 간결한 PR 설명 선호"에 대한 노트가 정확한 단어 겹침 없이도 "사용자 PR 스타일 선호" 같은 쿼리에 잘 표면화.

필터로 결과 집합 좁히기:
  - \`category\`: 한 타입으로 범위 제한(\`decision\` / \`insight\` 등)
  - \`tags\`: 태그 간 AND
  - \`min_importance\`: 고위험 회상 위해 낮은 importance 노트 제외
  - \`limit\`: top-k cap(기본 ~10)

결과 형태: \`{id, snippet, category, tags, score}\`. Snippet은 매칭 부분 하이라이트하는 1-3문장 발췌 — 풀 노트 memory_read 여부 결정에 충분.

검색은 최신 인덱스 상태 사용 — 이전 턴에 작성된 노트도 검색 가능. Commit-then-rebuild 단계 없음.`,
  bestFor: [
    '사용자가 세션 이전에(또는 세션 중) X를 언급했는지 회상',
    '새 결정 전 유사한 이전 결정 찾기',
    '모순 발견("에이전트가 이미 다르게 결정했나?")',
    '에이전트가 놓칠 수 있는 컨텍스트 표면화',
  ],
  avoidWhen: [
    '노트 ID 이미 아는 경우 — memory_read 직접',
    '풀 inventory 원함 — memory_list',
    '큐레이션된 지식 검색 — knowledge_search가 적합',
  ],
  gotchas: [
    '하이브리드 scoring 때문에 낮은 텍스트 매칭이지만 높은 시맨틱 매칭 노트가 정확한 용어 히트보다 위로 랭크 가능. 유용하지만 때로 놀랍.',
    '빈 결과는 실제 신호 — "매칭 없음"은 보통 "에이전트가 이에 대해 쓴 적 없음" 의미.',
    'Limit 기본 ~10. 브레인스토밍 쿼리는 더 많이 원할 수 있음; 핀포인트 lookup은 적은 게 깔끔.',
    '필터 조합은 AND. 제한적 필터는 약한 필터에 좋은 매칭 있어도 빈 결과 반환 가능.',
  ],
  examples: [
    {
      caption: '배포 인프라 결정 회상',
      body: `{
  "query": "deployment infrastructure choices",
  "category": "decision",
  "min_importance": 3,
  "limit": 5
}`,
      note: '쿼리에 대한 관련도로 scored된 고importance decision 노트 최대 5개 반환.',
    },
  ],
  relatedTools: ['memory_read', 'memory_write', 'memory_list', 'knowledge_search'],
  relatedStages: ['18단계 (Memory)'],
  codeRef:
    'Geny / backend/tools/built_in/memory_tools.py:MemorySearchTool',
};

export const memorySearchToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
