/** Tool detail — memory_update (Geny / memory family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `memory_update edits an existing note in place — body content, tags, importance level, or category. The note's ID and creation timestamp survive; \`last_modified_at\` advances to now and the search index re-embeds the new body so subsequent memory_search calls see the updated content.

Use cases:
  - Refining a note as understanding deepens ("change importance from 3 to 4 because the decision turned out crucial")
  - Adding tags after the fact ("retroactively tag all auth-related decisions")
  - Correcting a fact the agent learned wrong ("update body: it was Pinecone, not Weaviate")

Partial update: pass only the fields you want to change. Omitted fields keep their previous values. To clear an optional field (tags, etc.), pass an empty array / null explicitly — the absence of the field is "leave alone", not "clear".

Updates trigger re-embedding when the body changes, which costs a small amount of memory backend compute. For high-frequency updates of the same note, consider whether the data really belongs in memory or somewhere more mutable (a key-value cache, a manifest field, etc.).`,
  bestFor: [
    'Refining importance or tags as understanding evolves',
    'Correcting factual errors in earlier notes',
    'Adding cross-cutting tags retroactively',
  ],
  avoidWhen: [
    'You\'re replacing the note wholesale — memory_delete + memory_write makes the change clearer in audit trail',
    'High-frequency mutations — memory isn\'t a database; consider another store',
  ],
  gotchas: [
    'Partial update semantics — omitted fields stay; to clear, pass an explicit empty value.',
    'Body changes trigger re-embedding (cost). Cosmetic edits (tag additions) don\'t.',
    'No history — the previous body is lost. If you need versioned notes, keep them as separate entries linked via memory_link.',
    'last_modified_at advances on any update including tag-only edits. memory_list sorts can shuffle as a result.',
  ],
  examples: [
    {
      caption: 'Bump importance after the decision proved critical',
      body: `{
  "name": "decision-vector-store-2026-04-15",
  "importance": 5
}`,
      note: 'Other fields unchanged. last_modified_at advances; the entry rises in importance-sorted lists.',
    },
  ],
  relatedTools: ['memory_read', 'memory_write', 'memory_delete', 'memory_link'],
  relatedStages: ['Stage 18 (Memory)'],
  codeRef:
    'Geny / backend/tools/built_in/memory_tools.py:MemoryUpdateTool',
};

const ko: ToolDetailContent = {
  body: `memory_update는 기존 노트를 in-place로 편집 — body 콘텐츠, tags, importance 레벨, category. 노트의 ID와 생성 타임스탬프 살아남음; \`last_modified_at\`이 지금으로 진행되고 검색 인덱스가 새 body 재임베드 — 후속 memory_search 호출이 업데이트된 콘텐츠 봄.

사용 사례:
  - 이해가 깊어지면서 노트 정제("결정이 중요했던 것으로 판명되어 importance 3에서 4로")
  - 사후 태그 추가("auth 관련 모든 결정에 retroactive 태그")
  - 에이전트가 잘못 학습한 사실 정정("body 업데이트: Weaviate가 아니라 Pinecone")

부분 업데이트: 변경 원하는 필드만 전달. 생략된 필드는 이전 값 유지. 선택적 필드(tags 등) clear는 명시적으로 빈 배열 / null 전달 — 필드 부재는 "그대로 두기", "clear" 아님.

Body 변경 시 업데이트가 재임베드 트리거 — 메모리 백엔드 compute 소량 비용. 같은 노트의 고빈도 업데이트는 데이터가 정말 메모리에 속하는지 또는 더 mutable한 곳(키-값 캐시, 매니페스트 필드 등)에 속하는지 검토.`,
  bestFor: [
    '이해 진화하면서 importance 또는 tags 정제',
    '이전 노트의 사실 오류 정정',
    '사후 cross-cutting 태그 추가',
  ],
  avoidWhen: [
    '노트 wholesale 교체 — memory_delete + memory_write가 audit trail에 변경 더 명확',
    '고빈도 mutation — 메모리는 DB 아님; 다른 store 검토',
  ],
  gotchas: [
    '부분 업데이트 시맨틱 — 생략된 필드 유지; clear는 명시적 빈 값 전달.',
    'Body 변경이 재임베드 트리거(비용). Cosmetic 편집(태그 추가)은 안 함.',
    'History 없음 — 이전 body 손실. 버전 노트 필요하면 memory_link로 연결된 별도 항목으로 유지.',
    '태그만 편집해도 last_modified_at 진행. 결과로 memory_list 정렬 shuffle 가능.',
  ],
  examples: [
    {
      caption: '결정이 critical로 판명된 후 importance 상향',
      body: `{
  "name": "decision-vector-store-2026-04-15",
  "importance": 5
}`,
      note: '다른 필드 unchanged. last_modified_at 진행; importance 정렬 리스트에서 항목 상승.',
    },
  ],
  relatedTools: ['memory_read', 'memory_write', 'memory_delete', 'memory_link'],
  relatedStages: ['18단계 (Memory)'],
  codeRef:
    'Geny / backend/tools/built_in/memory_tools.py:MemoryUpdateTool',
};

export const memoryUpdateToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
