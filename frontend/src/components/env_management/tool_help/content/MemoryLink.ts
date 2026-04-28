/** Tool detail — memory_link (Geny / memory family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `memory_link creates a wiki-style edge between two memory notes — a connected graph layered on top of the search index. Where memory_search finds notes by similarity and memory_list finds them by metadata, memory_link captures explicit relationships the agent or user has identified.

Link types are free-form labels — typical conventions:
  - \`relates_to\`: generic association
  - \`supersedes\`: this note supersedes the older one (decision evolution)
  - \`derived_from\`: this note was synthesised from the source
  - \`contradicts\`: the two notes disagree (useful when surfacing inconsistencies)
  - \`example_of\`: this note is a concrete example of a more general note

Links are directional. \`memory_link(a → b, "supersedes")\` means "a supersedes b" — running a backward query for "what does b supersede?" returns nothing because the edge points the other way.

Together with categories and tags, links form a knowledge graph the agent can traverse: "show me everything that supersedes this decision", "find the chain of derivations that led to this conclusion". For non-trivial knowledge work this often beats raw search.`,
  bestFor: [
    'Capturing decision evolution ("today\'s decision supersedes the one from last week")',
    'Building chains of reasoning the agent can later traverse',
    'Recording known contradictions that need future resolution',
    'Tying a concrete example to its abstract principle',
  ],
  avoidWhen: [
    'The relationship is implicit — search will find it by similarity',
    'You\'d be linking everything to everything — link explosion makes the graph unusable',
    'A note pair has no semantic relationship — links should mean something',
  ],
  gotchas: [
    'Links are directional. Choose the source / target carefully — wrong direction is harder to spot than wrong notes.',
    'Deleted notes leave dangling links. memory_link doesn\'t auto-clean targets that disappear.',
    'No link type taxonomy enforced — agents using ad-hoc labels can\'t share a coherent graph. Pick a small vocabulary and stick to it.',
    'Bulk linking can hurt graph quality. Each edge should mean something specific.',
  ],
  examples: [
    {
      caption: 'Mark a new decision as superseding an older one',
      body: `{
  "from_name": "decision-vector-store-2026-04-22",
  "to_name": "decision-vector-store-2026-04-15",
  "link_type": "supersedes"
}`,
      note: 'The newer decision now points back at the older one with type "supersedes". Future graph queries can follow the chain.',
    },
  ],
  relatedTools: ['memory_read', 'memory_search', 'memory_write'],
  relatedStages: ['Stage 18 (Memory)'],
  codeRef:
    'Geny / backend/tools/built_in/memory_tools.py:MemoryLinkTool',
};

const ko: ToolDetailContent = {
  body: `memory_link은 두 메모리 노트 간 wiki 스타일 엣지 생성 — 검색 인덱스 위에 layer된 connected graph. 유사도로 노트 찾는 memory_search와 메타데이터로 찾는 memory_list와 달리, memory_link는 에이전트나 사용자가 식별한 명시적 관계 캡처.

링크 타입은 자유 형식 라벨 — 전형적 컨벤션:
  - \`relates_to\`: 일반 연관
  - \`supersedes\`: 이 노트가 옛 것을 supersede(결정 진화)
  - \`derived_from\`: 소스에서 합성된 노트
  - \`contradicts\`: 두 노트 disagree(불일치 표면화에 유용)
  - \`example_of\`: 이 노트가 더 일반적 노트의 구체적 예시

링크는 방향성. \`memory_link(a → b, "supersedes")\`는 "a가 b를 supersede" — "b는 무엇을 supersede?" 역방향 쿼리는 엣지가 다른 방향이라 아무것도 반환 안 함.

Categories와 tags와 함께 링크는 에이전트가 traverse할 수 있는 지식 그래프 형성: "이 결정을 supersede하는 모든 것 보여줘", "이 결론에 이른 derivation 체인 찾기". 비자명한 지식 작업에 종종 raw 검색을 능가.`,
  bestFor: [
    '결정 진화 캡처("오늘의 결정이 지난주 것을 supersede")',
    '에이전트가 나중에 traverse할 추론 체인 구축',
    '미래 해결 필요한 알려진 모순 기록',
    '구체적 예시를 추상 원칙에 연결',
  ],
  avoidWhen: [
    '관계가 암시적 — 검색이 유사도로 찾음',
    '모든 것을 모든 것에 링크할 경우 — 링크 폭발이 그래프 무용지물로 만듦',
    '노트 pair에 시맨틱 관계 없음 — 링크는 의미가 있어야 함',
  ],
  gotchas: [
    '링크 방향성. 소스 / 타겟 신중히 선택 — 잘못된 방향은 잘못된 노트보다 발견 어려움.',
    '삭제된 노트는 dangling 링크 남김. memory_link가 사라지는 타겟 자동 cleanup 안 함.',
    '링크 타입 분류 강제 안 됨 — ad-hoc 라벨 사용 에이전트는 일관된 그래프 공유 불가. 작은 vocabulary 선택해 고수.',
    '벌크 링킹은 그래프 품질 해침. 각 엣지가 구체적 의미 가져야.',
  ],
  examples: [
    {
      caption: '새 결정이 옛 것을 supersede 표시',
      body: `{
  "from_name": "decision-vector-store-2026-04-22",
  "to_name": "decision-vector-store-2026-04-15",
  "link_type": "supersedes"
}`,
      note: '더 새로운 결정이 옛 것을 "supersedes" 타입으로 가리킴. 향후 그래프 쿼리가 체인 follow.',
    },
  ],
  relatedTools: ['memory_read', 'memory_search', 'memory_write'],
  relatedStages: ['18단계 (Memory)'],
  codeRef:
    'Geny / backend/tools/built_in/memory_tools.py:MemoryLinkTool',
};

export const memoryLinkToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
