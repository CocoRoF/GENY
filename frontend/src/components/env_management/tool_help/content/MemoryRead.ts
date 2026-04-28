/** Tool detail — memory_read (Geny / memory family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `memory_read fetches a specific memory note by its filename / ID. Returns the full content — body text plus metadata (category, tags, importance, created_at, last_modified_at).

The two-step pattern is "search → read": memory_search finds candidates by semantic similarity (returning IDs + snippets), then memory_read pulls the full note for the relevant one. memory_search\'s snippets are short for ranking; the agent reads the full note when it actually needs the content.

Returns an error if the ID doesn\'t exist (deleted note, typo, wrong scope). Memory\'s storage is per-session by default — an ID from another session won\'t resolve unless you\'ve configured a cross-session backend.

Reading doesn\'t mutate state. The note\'s last_modified_at doesn\'t update on read; only memory_update writes change it.`,
  bestFor: [
    'Following up on a memory_search hit',
    'Re-reading a known note when you need the full content (not just a snippet)',
    'Checking metadata of a specific note (importance, tags) before deciding to update or delete it',
  ],
  avoidWhen: [
    'You don\'t have an ID — search first',
    'You want metadata only — memory_list with name_pattern is more efficient for inventory',
    'You want to scan all notes — memory_list, not a loop of memory_read',
  ],
  gotchas: [
    'IDs are scoped to the memory backend. A persistent backend\'s IDs differ from a transient backend\'s.',
    'Deleted notes return an error, not empty content. Don\'t treat "not found" as "no body".',
    'Reading is fast and free of side effects — agents that\'re unsure should read before deleting.',
  ],
  examples: [
    {
      caption: 'Read a specific memory note',
      body: `{
  "name": "decision-vector-store-2026-04-15"
}`,
      note: 'Returns full body + metadata. ID typically comes from a memory_search result.',
    },
  ],
  relatedTools: ['memory_write', 'memory_search', 'memory_list', 'memory_update'],
  relatedStages: ['Stage 18 (Memory)'],
  codeRef:
    'Geny / backend/tools/built_in/memory_tools.py:MemoryReadTool',
};

const ko: ToolDetailContent = {
  body: `memory_read는 특정 메모리 노트를 파일명 / ID로 fetch합니다. 풀 콘텐츠 반환 — body 텍스트 + 메타데이터(category, tags, importance, created_at, last_modified_at).

두 단계 패턴은 "검색 → 읽기": memory_search가 시맨틱 유사도로 후보 찾기(ID + snippet 반환), 그 후 memory_read가 관련 있는 것의 풀 노트 가져오기. memory_search의 snippet은 ranking용으로 짧음; 에이전트가 실제로 콘텐츠 필요할 때 풀 노트 읽기.

ID 존재 안 하면 에러 반환(삭제된 노트, 오타, 잘못된 스코프). 메모리 저장은 기본 세션별 — cross-session 백엔드 설정 안 했으면 다른 세션의 ID는 resolve 안 됨.

읽기는 상태 mutate 안 함. 읽기에 노트의 last_modified_at 업데이트 안 됨; memory_update 쓰기만 변경.`,
  bestFor: [
    'memory_search 히트 follow-up',
    '풀 콘텐츠(snippet 아님) 필요할 때 알려진 노트 재읽기',
    'update / delete 결정 전 특정 노트의 메타데이터(importance, tags) 확인',
  ],
  avoidWhen: [
    'ID 없음 — 먼저 검색',
    '메타데이터만 원함 — name_pattern과 함께 memory_list가 inventory에 더 효율적',
    '모든 노트 스캔 원함 — memory_read 루프 아닌 memory_list',
  ],
  gotchas: [
    'ID는 메모리 백엔드별 스코프. 영속 백엔드의 ID와 transient 백엔드의 ID 다름.',
    '삭제된 노트는 빈 콘텐츠 아닌 에러 반환. "not found"를 "no body"로 취급 금지.',
    '읽기는 빠르고 사이드이펙트 없음 — 불확실한 에이전트는 삭제 전 읽기.',
  ],
  examples: [
    {
      caption: '특정 메모리 노트 읽기',
      body: `{
  "name": "decision-vector-store-2026-04-15"
}`,
      note: '풀 body + 메타데이터 반환. ID는 보통 memory_search 결과에서 옴.',
    },
  ],
  relatedTools: ['memory_write', 'memory_search', 'memory_list', 'memory_update'],
  relatedStages: ['18단계 (Memory)'],
  codeRef:
    'Geny / backend/tools/built_in/memory_tools.py:MemoryReadTool',
};

export const memoryReadToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
