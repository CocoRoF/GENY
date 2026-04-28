/** Tool detail — knowledge_list (Geny / knowledge family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `knowledge_list enumerates the user's curated knowledge base by metadata filters (category, tags, recency). The browse companion to knowledge_search\'s relevance-ranked retrieval.

Use cases:
  - Onboarding ("show me what curated knowledge exists about this project")
  - Pre-flight before promoting a memory ("does similar knowledge already exist?")
  - User-facing inventory ("here\'s what I have on file for you")

Like memory_list, returns metadata only — IDs, names, categories, tags, timestamps. The agent picks one and knowledge_read for full body. Sort defaults to recency; \`sort_by: "name"\` available for alphabetical browsing.`,
  bestFor: [
    'Browsing the user\'s curated knowledge by category',
    'Avoiding duplicate promotions (knowledge already exists?)',
    'Building a table-of-contents response for the user',
  ],
  avoidWhen: [
    'You\'re looking for relevance — knowledge_search by query',
    'You want one specific note — knowledge_read by name',
  ],
  gotchas: [
    'Filter combinations are AND. Empty result with strict filters often means filters too narrow, not "no knowledge".',
    'Default sort is recency. For alphabetical browse pass `sort_by: "name"`.',
    'Body NOT returned. Agent must knowledge_read for content.',
    'Pagination — large stores return only the first page by default.',
  ],
  examples: [
    {
      caption: 'List all reference-category knowledge',
      body: `{
  "category": "reference",
  "limit": 30
}`,
      note: 'Returns metadata for up to 30 reference notes ordered newest-first.',
    },
  ],
  relatedTools: ['knowledge_search', 'knowledge_read', 'memory_list'],
  relatedStages: ['Stage 18 (Memory)'],
  codeRef:
    'Geny / backend/tools/built_in/knowledge_tools.py:KnowledgeListTool',
};

const ko: ToolDetailContent = {
  body: `knowledge_list는 사용자의 큐레이션 지식 베이스를 메타데이터 필터(category, tags, recency)로 enumerate합니다. knowledge_search의 관련도 ranking 검색의 브라우징 카운터파트.

사용 사례:
  - 온보딩("이 프로젝트에 대한 큐레이션 지식 무엇 있나?")
  - 메모리 승격 전 사전 확인("유사한 지식 이미 존재?")
  - 사용자 대면 inventory("당신을 위한 파일 내용")

memory_list와 같이 메타데이터만 반환 — ID, 이름, category, tags, 타임스탬프. 에이전트가 하나 골라 knowledge_read로 풀 body. 정렬 기본 recency; 알파벳 브라우징은 \`sort_by: "name"\`.`,
  bestFor: [
    'Category별 사용자 큐레이션 지식 브라우징',
    '중복 승격 회피(지식 이미 존재?)',
    '사용자용 목차 응답 구축',
  ],
  avoidWhen: [
    '관련도 찾기 — 쿼리로 knowledge_search',
    '특정 노트 — 이름으로 knowledge_read',
  ],
  gotchas: [
    '필터 조합 AND. 엄격한 필터의 빈 결과는 "지식 없음" 아닌 필터 너무 좁음 의미.',
    '기본 정렬 recency. 알파벳 브라우징은 `sort_by: "name"`.',
    'Body 반환 안 함. 콘텐츠는 knowledge_read.',
    '페이지네이션 — 큰 store는 기본 첫 페이지만.',
  ],
  examples: [
    {
      caption: '모든 reference category 지식 list',
      body: `{
  "category": "reference",
  "limit": 30
}`,
      note: '최신 우선 정렬된 reference 노트 메타데이터 최대 30개 반환.',
    },
  ],
  relatedTools: ['knowledge_search', 'knowledge_read', 'memory_list'],
  relatedStages: ['18단계 (Memory)'],
  codeRef:
    'Geny / backend/tools/built_in/knowledge_tools.py:KnowledgeListTool',
};

export const knowledgeListToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
