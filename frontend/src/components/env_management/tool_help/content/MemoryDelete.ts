/** Tool detail — memory_delete (Geny / memory family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `memory_delete permanently removes a memory note and re-indexes the search store so the deleted content stops surfacing. Irreversible — the note's body, tags, and metadata are gone. memory_link entries pointing TO the deleted note become broken (the link target no longer exists; the link itself remains until cleaned up).

Use cases:
  - Cleanup after long sessions accumulate stale low-importance notes
  - Removing duplicates spotted via memory_search
  - Honouring user requests to "forget X" (privacy / accuracy)

The most common failure mode is over-deletion. Memory is the agent's working knowledge — deleting too eagerly forgets context that turns out useful later. Default to "delete only when clearly stale or wrong"; for archival cleanup, prefer importance downgrades over deletions.

Returns success even if the note was already deleted (idempotent). Audit trail records the deletion event with timestamp and (when hooks are enabled) the agent's invocation context.`,
  bestFor: [
    'Cleaning up obvious noise (test notes, accidental writes)',
    'Removing notes the user explicitly asked the agent to forget',
    'Deduplicating after a memory_search reveals near-identical entries',
  ],
  avoidWhen: [
    'You\'re unsure whether the note will be useful — downgrade importance instead',
    'Wholesale clearing — that\'s a backend admin operation, not a per-note loop',
    'Removing factually-wrong content — memory_update to correct preserves the timeline',
  ],
  gotchas: [
    'Irreversible. The note\'s body is gone — restore from backup if your backend supports it.',
    'Inbound memory_link entries are NOT auto-cleaned. They\'ll resolve to "not found" on future memory_read.',
    'Idempotent — deleting an already-deleted note returns success without error.',
    'Hooks fire (`pre_tool_use`, `post_tool_use`) for each delete; bulk loops can be noisy in audit logs.',
  ],
  examples: [
    {
      caption: 'Remove a stale note',
      body: `{
  "name": "scratch-2026-04-12-experiment-aborted"
}`,
      note: 'Note removed. Future memory_search / memory_list won\'t see it.',
    },
  ],
  relatedTools: ['memory_read', 'memory_update', 'memory_list'],
  relatedStages: ['Stage 18 (Memory)'],
  codeRef:
    'Geny / backend/tools/built_in/memory_tools.py:MemoryDeleteTool',
};

const ko: ToolDetailContent = {
  body: `memory_delete는 메모리 노트를 영구적으로 제거하고 검색 store 재인덱스 — 삭제된 콘텐츠가 표면화 안 됨. 비가역 — 노트의 body, tags, 메타데이터 사라짐. 삭제된 노트를 가리키는 memory_link 항목은 broken(링크 타겟 더 이상 존재 안 함; 링크 자체는 cleanup 전까지 남음).

사용 사례:
  - 긴 세션이 누적한 stale 낮은 importance 노트 cleanup
  - memory_search로 발견된 중복 제거
  - 사용자의 "X 잊어줘" 요청 수행(프라이버시 / 정확성)

가장 흔한 실패 모드는 과도한 삭제. 메모리는 에이전트의 working 지식 — 너무 적극적으로 삭제하면 나중에 유용할 컨텍스트 망각. "명확히 stale하거나 틀린 경우만 삭제" 기본; archival cleanup은 삭제보다 importance downgrade 선호.

이미 삭제된 노트도 성공 반환(idempotent). Audit trail이 타임스탬프와 (훅 활성 시) 에이전트의 invocation 컨텍스트와 함께 삭제 이벤트 기록.`,
  bestFor: [
    '명백한 노이즈 cleanup(테스트 노트, 우발적 쓰기)',
    '사용자가 에이전트에게 잊으라고 명시적으로 요청한 노트 제거',
    'memory_search로 거의 동일한 항목 발견 후 dedup',
  ],
  avoidWhen: [
    '노트 유용성 불확실 — 대신 importance downgrade',
    '전체 clearing — 노트별 루프 아닌 백엔드 admin 작업',
    '사실이 틀린 콘텐츠 제거 — memory_update로 정정이 타임라인 보존',
  ],
  gotchas: [
    '비가역. 노트 body 사라짐 — 백엔드 지원 시 백업에서 복원.',
    '인바운드 memory_link 항목 자동 cleanup 안 됨. 향후 memory_read에서 "not found" 해결.',
    'Idempotent — 이미 삭제된 노트 삭제도 에러 없이 성공.',
    '각 삭제마다 훅 발화(`pre_tool_use`, `post_tool_use`); 벌크 루프는 audit log에서 noisy.',
  ],
  examples: [
    {
      caption: 'Stale 노트 제거',
      body: `{
  "name": "scratch-2026-04-12-experiment-aborted"
}`,
      note: '노트 제거. 향후 memory_search / memory_list가 안 봄.',
    },
  ],
  relatedTools: ['memory_read', 'memory_update', 'memory_list'],
  relatedStages: ['18단계 (Memory)'],
  codeRef:
    'Geny / backend/tools/built_in/memory_tools.py:MemoryDeleteTool',
};

export const memoryDeleteToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
