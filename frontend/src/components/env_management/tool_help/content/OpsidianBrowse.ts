/** Tool detail — opsidian_browse (Geny / opsidian family). */

import type {
  ToolDetailContent,
  ToolDetailFactory,
} from '../types';

const en: ToolDetailContent = {
  body: `opsidian_browse lists notes in the user's personal Opsidian knowledge vault — title, category, tags. Different from knowledge_*: Opsidian is the user\'s OWN tool (their existing note-taking app), browsed read-only by the agent. Knowledge_* is Geny\'s curated layer.

The agent uses opsidian_browse to discover what the user already knows / writes about — useful when answering "do I have notes on X?" or building a response that should respect the user\'s existing terminology.

Read-only by design. The agent never writes back to Opsidian — it can read for context, but the user owns the source of truth there. To save something for the user, use SendUserFile or knowledge_promote (which lands in Geny\'s curated knowledge, separately).

Filters: optional category and tag arguments. Returns a paginated list — pass \`limit\` to control batch size.`,
  bestFor: [
    'Pre-flight when the user references "my notes" or "I wrote down somewhere"',
    'Discovering the user\'s vocabulary / structure before generating new content',
    'Citation — knowing what to point at when the user asks for refs',
  ],
  avoidWhen: [
    'Looking for the agent\'s own knowledge — knowledge_search instead',
    'Wanting to write to the user\'s vault — Opsidian is read-only from the agent\'s side',
    'No Opsidian configured — returns empty silently in some host configs',
  ],
  gotchas: [
    'Read-only. The agent CAN\'T edit Opsidian notes; it can only read them.',
    'Opsidian path resolution depends on host config (vault location). Misconfiguration returns empty rather than erroring loudly.',
    'Pagination — large vaults need explicit limit / offset; default returns the first page.',
    'Sync state matters — if the user just edited and hasn\'t synced, the agent reads the older version.',
  ],
  examples: [
    {
      caption: 'Browse all notes tagged "project-x"',
      body: `{
  "tags": ["project-x"]
}`,
      note: 'Returns metadata for matching notes. Agent uses opsidian_read for full content.',
    },
  ],
  relatedTools: ['opsidian_read', 'knowledge_search'],
  relatedStages: ['Stage 18 (Memory)'],
  codeRef:
    'Geny / backend/tools/built_in/knowledge_tools.py:OpsidianBrowseTool',
};

const ko: ToolDetailContent = {
  body: `opsidian_browse는 사용자의 개인 Opsidian 지식 vault의 노트를 list — 제목, category, tags. knowledge_*와 다름: Opsidian은 사용자의 자체 도구(기존 노트 앱), 에이전트가 read-only로 브라우징. Knowledge_*는 Geny의 큐레이션 레이어.

에이전트가 opsidian_browse로 사용자가 이미 알고 / 쓰는 것 발견 — "X에 대한 노트 있나?" 답하거나 사용자의 기존 용어 존중하는 응답 구축에 유용.

설계상 read-only. 에이전트가 Opsidian에 절대 다시 쓰지 않음 — 컨텍스트로 읽을 수 있지만, 사용자가 거기 truth source 소유. 사용자에게 무언가 저장하려면 SendUserFile 또는 knowledge_promote(Geny의 큐레이션 지식에 land, 별개).

필터: 선택적 category와 tag 인자. 페이지네이션 리스트 반환 — 배치 크기는 \`limit\` 전달.`,
  bestFor: [
    '사용자가 "내 노트" 또는 "어딘가 적어둠" 참조 시 사전 확인',
    '새 콘텐츠 생성 전 사용자의 어휘 / 구조 발견',
    '인용 — 사용자가 ref 요청 시 무엇을 가리킬지 알기',
  ],
  avoidWhen: [
    '에이전트 자체 지식 찾기 — knowledge_search',
    '사용자 vault에 쓰기 원함 — 에이전트 측에서 Opsidian read-only',
    'Opsidian 설정 안 됨 — 일부 호스트 설정은 silent하게 빈 결과 반환',
  ],
  gotchas: [
    'Read-only. 에이전트가 Opsidian 노트 편집 불가; 읽기만.',
    'Opsidian 경로 해석은 호스트 설정 의존(vault 위치). 잘못된 설정은 시끄러운 에러 대신 빈 결과 반환.',
    '페이지네이션 — 큰 vault는 명시적 limit / offset 필요; 기본은 첫 페이지.',
    '동기화 상태 중요 — 사용자가 방금 편집하고 sync 안 했으면 에이전트가 옛 버전 읽음.',
  ],
  examples: [
    {
      caption: '"project-x" 태그된 모든 노트 브라우징',
      body: `{
  "tags": ["project-x"]
}`,
      note: '매칭 노트 메타데이터 반환. 에이전트가 풀 콘텐츠는 opsidian_read 사용.',
    },
  ],
  relatedTools: ['opsidian_read', 'knowledge_search'],
  relatedStages: ['18단계 (Memory)'],
  codeRef:
    'Geny / backend/tools/built_in/knowledge_tools.py:OpsidianBrowseTool',
};

export const opsidianBrowseToolHelp: ToolDetailFactory = (locale) =>
  locale === 'ko' ? ko : en;
