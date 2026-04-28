/** Tool detail — knowledge_read (Geny / knowledge family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `knowledge_read fetches a specific curated knowledge note by filename. Returns the full body plus metadata — category, tags, created/modified timestamps, source pointer (which memory note this was promoted from, if any).

The intended pattern matches memory: knowledge_search → knowledge_read. Search returns IDs + snippets for ranking; read returns the full content for action. Reading is free of side effects; the timestamp doesn't update on read.

When the user has hand-edited a knowledge note, knowledge_read returns the user's version — not what the agent originally promoted. This is by design: knowledge is the user's truth, and the agent should treat their edits as authoritative.`,
  bestFor: [
    'Following up on a knowledge_search hit with full content',
    'Re-reading a known knowledge note when summary isn\'t enough',
    'Verifying user edits vs the original promoted version',
  ],
  avoidWhen: [
    'You don\'t have an ID — knowledge_search first',
    'You want metadata only — knowledge_list with name_pattern',
  ],
  gotchas: [
    'Returns the latest user-edited version, not the agent-promoted original.',
    'IDs persist across edits — the same ID always points to the same knowledge entry, even after content changes.',
    'Deleted knowledge returns an error, not empty content.',
  ],
  examples: [
    {
      caption: 'Read a deployment runbook from curated knowledge',
      body: `{
  "name": "runbook-prod-deploy"
}`,
      note: 'Full body + metadata. Reflects the latest user edits.',
    },
  ],
  relatedTools: ['knowledge_search', 'knowledge_list', 'memory_read'],
  relatedStages: ['Stage 18 (Memory)'],
  codeRef:
    'Geny / backend/tools/built_in/knowledge_tools.py:KnowledgeReadTool',
};

const ko: ToolDetailContent = {
  body: `knowledge_read는 특정 큐레이션 지식 노트를 파일명으로 fetch합니다. 풀 body + 메타데이터 반환 — category, tags, created/modified 타임스탬프, source 포인터(승격된 메모리 노트, 있으면).

의도된 패턴은 memory와 매칭: knowledge_search → knowledge_read. 검색이 ranking용 ID + snippet 반환; read가 액션용 풀 콘텐츠 반환. 읽기는 사이드이펙트 없음; 읽기에 타임스탬프 업데이트 안 됨.

사용자가 지식 노트를 수동 편집했으면 knowledge_read가 사용자 버전 반환 — 에이전트가 처음 승격한 것 아님. 의도된 설계: 지식은 사용자의 truth, 에이전트가 그 편집을 authoritative로 취급해야 함.`,
  bestFor: [
    'knowledge_search 히트의 풀 콘텐츠 follow-up',
    '요약 부족할 때 알려진 지식 노트 재읽기',
    '사용자 편집 vs 원래 승격 버전 검증',
  ],
  avoidWhen: [
    'ID 없음 — 먼저 knowledge_search',
    '메타데이터만 원함 — name_pattern과 함께 knowledge_list',
  ],
  gotchas: [
    '에이전트 승격 원본이 아닌 최신 사용자 편집 버전 반환.',
    'ID는 편집 가로질러 영속 — 콘텐츠 변경 후에도 같은 ID가 항상 같은 지식 항목 가리킴.',
    '삭제된 지식은 빈 콘텐츠 아닌 에러 반환.',
  ],
  examples: [
    {
      caption: '큐레이션 지식에서 deployment runbook 읽기',
      body: `{
  "name": "runbook-prod-deploy"
}`,
      note: '풀 body + 메타데이터. 최신 사용자 편집 반영.',
    },
  ],
  relatedTools: ['knowledge_search', 'knowledge_list', 'memory_read'],
  relatedStages: ['18단계 (Memory)'],
  codeRef:
    'Geny / backend/tools/built_in/knowledge_tools.py:KnowledgeReadTool',
};

export const knowledgeReadToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
