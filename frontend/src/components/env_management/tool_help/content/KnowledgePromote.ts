/** Tool detail — knowledge_promote (Geny / knowledge family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `knowledge_promote sweetens a memory note into the curated knowledge base — moving it from the agent\'s working scratchpad to the user\'s authoritative vault. Triggers the curation hook chain (validation, formatting cleanup, optional user approval depending on host policy) and re-indexes the entry into the knowledge search store.

The original memory note typically remains as a record of the agent\'s thinking. Some host configurations auto-delete the source memory after promotion to avoid duplication; check your deployment\'s settings.

Promotion is the moment a fact graduates from "the agent thinks this" to "the user has approved this". Subsequent knowledge_search hits weight higher than memory_search hits when both contain related content, so promotion has real downstream effect on agent reasoning.

Use sparingly. Memory accumulates everything the agent thinks worth remembering; knowledge should be the curated subset that has clear lasting value. Aggressive promotion dilutes the signal.`,
  bestFor: [
    'Crystallising a hard-won decision into durable knowledge',
    'Sharing a memory across sessions (knowledge persists; some memory backends don\'t)',
    'Offering the user a "save this for me" pathway when an insight feels load-bearing',
  ],
  avoidWhen: [
    'The note isn\'t worth long-term retention — leave it in memory',
    'Similar knowledge already exists — extend the existing entry instead of duplicating',
    'You\'re not sure if it\'s right — promote only when confident; the user expects accuracy',
  ],
  gotchas: [
    'Some host configs require user approval before the promotion finalises. The tool returns "pending" in that case; the user must confirm in UI.',
    'The curation hook chain may reformat or reject the content. The agent\'s exact phrasing isn\'t guaranteed to survive.',
    'Source memory may auto-delete depending on host policy. If the agent needs both, write a copy to memory first.',
    'Knowledge entries are indexed in a separate store — don\'t expect the new entry to surface in memory_search.',
  ],
  examples: [
    {
      caption: 'Promote a key decision to curated knowledge',
      body: `{
  "memory_name": "decision-vector-store-2026-04-15",
  "knowledge_category": "decision",
  "knowledge_tags": ["infra", "memory", "decided"]
}`,
      note: 'Returns a knowledge ID. Subsequent knowledge_search calls find the entry; the source memory note remains unless host policy auto-deletes.',
    },
  ],
  relatedTools: ['memory_read', 'memory_write', 'knowledge_search'],
  relatedStages: ['Stage 18 (Memory)'],
  codeRef:
    'Geny / backend/tools/built_in/knowledge_tools.py:KnowledgePromoteTool',
};

const ko: ToolDetailContent = {
  body: `knowledge_promote는 메모리 노트를 큐레이션 지식 베이스로 sweeten — 에이전트의 working 스크래치패드에서 사용자의 authoritative vault로 이동. 큐레이션 훅 체인 트리거(검증, 포맷팅 cleanup, 호스트 정책에 따른 선택적 사용자 승인) 후 항목을 지식 검색 store에 재인덱싱.

원래 메모리 노트는 보통 에이전트 사고의 기록으로 남음. 일부 호스트 설정은 중복 회피를 위해 승격 후 소스 메모리 자동 삭제; 배포 설정 확인.

승격은 사실이 "에이전트가 이렇게 생각함"에서 "사용자가 이를 승인함"으로 graduate하는 순간. 후속 knowledge_search 히트는 둘 다 관련 콘텐츠 포함 시 memory_search 히트보다 더 높은 weight, 승격이 에이전트 추론에 실제 하류 효과.

신중히 사용. 메모리는 에이전트가 기억할 가치 있다고 생각하는 모든 것 누적; 지식은 명확하게 지속적 가치 있는 큐레이션 서브셋이어야. 공격적 승격이 신호 희석.`,
  bestFor: [
    '힘들게 얻은 결정을 지속적 지식으로 결정화',
    '세션 간 메모리 공유(지식 영속; 일부 메모리 백엔드 안 함)',
    '통찰이 load-bearing 느낄 때 사용자에게 "이거 저장해" 경로 제공',
  ],
  avoidWhen: [
    '노트가 장기 보존 가치 없음 — 메모리에 남겨두기',
    '유사 지식 이미 존재 — 중복 대신 기존 항목 확장',
    '맞는지 확신 없음 — 확신 있을 때만 승격; 사용자가 정확성 기대',
  ],
  gotchas: [
    '일부 호스트 설정은 승격 finalise 전 사용자 승인 요구. 그 경우 도구가 "pending" 반환; 사용자가 UI에서 확인.',
    '큐레이션 훅 체인이 콘텐츠 reformat 또는 거부 가능. 에이전트의 정확한 표현이 살아남는다는 보장 없음.',
    '소스 메모리는 호스트 정책에 따라 자동 삭제될 수 있음. 에이전트가 둘 다 필요하면 먼저 메모리에 복사 작성.',
    '지식 항목은 별도 store에 인덱스 — 새 항목이 memory_search에 표면화 기대 금지.',
  ],
  examples: [
    {
      caption: '핵심 결정을 큐레이션 지식으로 승격',
      body: `{
  "memory_name": "decision-vector-store-2026-04-15",
  "knowledge_category": "decision",
  "knowledge_tags": ["infra", "memory", "decided"]
}`,
      note: '지식 ID 반환. 후속 knowledge_search 호출이 항목 찾음; 호스트 정책 자동 삭제 아니면 소스 메모리 노트 남음.',
    },
  ],
  relatedTools: ['memory_read', 'memory_write', 'knowledge_search'],
  relatedStages: ['18단계 (Memory)'],
  codeRef:
    'Geny / backend/tools/built_in/knowledge_tools.py:KnowledgePromoteTool',
};

export const knowledgePromoteToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
